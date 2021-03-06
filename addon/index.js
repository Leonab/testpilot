/*
 * This Source Code is subject to the terms of the Mozilla Public License
 * version 2.0 (the 'License'). You can obtain a copy of the License at
 * http://mozilla.org/MPL/2.0/.
 */

const EXPERIMENT_UPDATE_INTERVAL = 12 * 60 * 60 * 1000; // 12 hours

const { Cc, Ci, Cu } = require('chrome');
const AddonManager = Cu.import('resource://gre/modules/AddonManager.jsm').AddonManager;
const cookieManager2 = Cc['@mozilla.org/cookiemanager;1']
                       .getService(Ci.nsICookieManager2);

const self = require('sdk/self');
const store = require('sdk/simple-storage').storage;
const tabs = require('sdk/tabs');
const request = require('sdk/request').Request;
const simplePrefs = require('sdk/simple-prefs');
const URL = require('sdk/url').URL;
const history = require('sdk/places/history');
const Metrics = require('./lib/metrics');
const survey = require('./lib/survey');
const WebExtensionChannels = require('./lib/webextension-channels');
const ToolbarButton = require('./lib/toolbar-button');
const ExperimentNotifications = require('./lib/experiment-notifications');
const { App } = require('./lib/app');

const settings = {};
let app;
// Canned selectable server environment configs
const SERVER_ENVIRONMENTS = {
  local: {
    BASE_URL: 'http://testpilot.dev:8000',
    TESTPILOT_PREFIX: 'testpilot.addon.LOCAL.',
    WHITELIST_URLS: 'https://www.mozilla.org/*,about:home',
    BADGE_COLOR: '#AA00AA'
  },
  dev: {
    BASE_URL: 'http://testpilot.dev.mozaws.net',
    TESTPILOT_PREFIX: 'testpilot.addon.DEV.',
    WHITELIST_URLS: 'https://www.mozilla.org/*,about:home',
    BADGE_COLOR: '#AAAA00'
  },
  stage: {
    BASE_URL: 'https://testpilot.stage.mozaws.net',
    TESTPILOT_PREFIX: 'testpilot.addon.STAGE.',
    WHITELIST_URLS: 'https://www.mozilla.org/*,about:home',
    BADGE_COLOR: '#A0AAA0'
  },
  production: {
    BASE_URL: 'https://testpilot.firefox.com',
    TESTPILOT_PREFIX: 'testpilot.addon.MAIN.',
    WHITELIST_URLS: 'https://www.mozilla.org/*,about:home',
    BADGE_COLOR: '#00AAAA'
  }
};

function changeApp(env) {
  if (app) {
    app.destroy();
  }

  app = new App({
    baseUrl: env.BASE_URL,
    badgeColor: env.BADGE_COLOR,
    whitelist: env.WHITELIST_URLS,
    addonVersion: self.version,
    reloadInterval: EXPERIMENT_UPDATE_INTERVAL
  });
  app.on('loaded', experimentsLoaded)
    .on('uninstall-self', uninstallSelf)
    .on('install-experiment', installExperiment)
    .on('uninstall-experiment', uninstallExperiment)
    .on('sync-installed', () => {
      app.send(
        'sync-installed-result',
        {
          clientUUID: store.clientUUID,
          installed: store.installedAddons
        }
      );
    });
}

function updatePrefs() {
  // Select the environment, with production as a default.
  const envName = simplePrefs.prefs.SERVER_ENVIRONMENT;
  const env = (envName in SERVER_ENVIRONMENTS) ?
    SERVER_ENVIRONMENTS[envName] : SERVER_ENVIRONMENTS.production;

  // Update the settings from selected environment
  Object.assign(settings, {
    BASE_URL: env.BASE_URL,
    ALLOWED_ORIGINS: env.BASE_URL + '/*',
    ALLOWED_ORIGINS_VIEWINSTALLEDFLAG: env.BASE_URL + '/*,' + env.WHITELIST_URLS,
    HOSTNAME: URL(env.BASE_URL).hostname, // eslint-disable-line new-cap
    TESTPILOT_PREFIX: env.TESTPILOT_PREFIX
  });

  // kickoff our random experiment surveys
  survey.init();

  changeApp(env);

  if (self.loadReason === 'install') {
    app.send('addon-self:installed');
  } else if (self.loadReason === 'enable') {
    app.send('addon-self:enabled');
  } else if (self.loadReason === 'upgrade') {
    app.send('addon-self:upgraded');
  }
}

function initServerEnvironmentPreference() {
  // Search recent browser history for visits to known server environments.
  // HACK: Docs say that multiple queries get OR'ed together, but that doesn't
  // seem to work. So, let's use Promise.all() to fire off multiple queries and
  // collate them ourselves.
  const envNames = Object.keys(SERVER_ENVIRONMENTS);
  Promise.all(envNames.map(name => new Promise(resolve => {
    history.search(
      {url: SERVER_ENVIRONMENTS[name].BASE_URL + '/*'},
      {count: 1, sort: 'date', descending: true}
    ).on('end', results => {
      // Map the history search into the name of the environment and the time
      // of the last visit, using null if there was no visit found.
      return resolve({
        name: name,
        time: results.length ? results[0].time : null
      });
    });
  }))).then(resultsRaw => {
    // Filter out non-results and sort in descending time order.
    const results = resultsRaw.filter(item => item.time !== null);
    results.sort((a, b) => b.time - a.time);

    // First result is the last visited environment.
    const lastVisitedName = results.length > 0 ? results[0].name : null;
    const currName = simplePrefs.prefs.SERVER_ENVIRONMENT;

    if (lastVisitedName && lastVisitedName !== currName) {
      // Switch to the last visited environment.
      simplePrefs.prefs.SERVER_ENVIRONMENT = lastVisitedName;
      updatePrefs();
    }

    if (self.loadReason === 'install') {
      openOnboardingTab();
    }

    // Finally, watch for pref changes, kick off the env setup.
    simplePrefs.on('SERVER_ENVIRONMENT', updatePrefs);
  });
}

function openOnboardingTab() {
  tabs.open({
    url: settings.BASE_URL + '/onboarding',
    inBackground: true
  });
}

function experimentsLoaded(experiments) {
  store.availableExperiments = experiments;
  ExperimentNotifications.maybeSendNotifications();
  ToolbarButton.updateButtonBadge();
  AddonManager.getAllAddons(addons => {
    // Filter addons by known experiments, index by ID
    store.installedAddons = {};
    addons.filter(addon => isTestpilotAddonID(addon.id))
          .forEach(setAddonActiveState);
  });
}

function setAddonActiveState(addon) {
  const xp = store.availableExperiments[addon.id];
  if (xp) { delete xp.active; }
  store.installedAddons[addon.id] = Object.assign({
    active: addon.isActive,
    installDate: addon.installDate
  }, store.availableExperiments[addon.id]);
}

function uninstallExperiment(experiment) {
  if (isTestpilotAddonID(experiment.addon_id)) {
    AddonManager.getAddonByID(experiment.addon_id, a => {
      if (a) { a.uninstall(); }
    });
  }
}

function installExperiment(experiment) {
  if (isTestpilotAddonID(experiment.addon_id)) {
    AddonManager.getInstallForURL(experiment.xpi_url, install => {
      install.install();
    }, 'application/x-xpinstall');
  }
}

function uninstallSelf() {
  // First, kick out all the experiment add-ons
  Object.keys(store.installedAddons).forEach(id => {
    uninstallExperiment({addon_id: id});
  });
  // Then, uninstall ourselves
  AddonManager.getAddonByID(self.id, a => a.uninstall());
}

function formatInstallData(install, addon) {
  const formatted = {
    'name': install.name || '',
    'error': install.error,
    'state': install.state,
    'version': install.version || '',
    'progress': install.progress,
    'maxProgress': install.maxProgress
  };

  if (addon) {
    Object.assign(formatted, {
      'id': addon.id,
      'description': addon.description,
      'homepageURL': addon.homepageURL,
      'iconURL': addon.iconURL,
      'size': addon.size,
      'signedState': addon.signedState,
      'permissions': addon.permissions
    });
  }

  return formatted;
}

function isTestpilotAddonID(id) {
  return app.hasAddonID(id);
}

function syncAddonInstallation(addonID) {
  const experiment = store.availableExperiments[addonID];
  const method = (addonID in store.installedAddons) ? 'put' : 'delete';
  // HACK: Use the same "done" handler for 2xx & 4xx responses -
  // 200 = PUT success, 410 = DELETE success, 404 = DELETE redundant
  const done = (res) => [addonID, method, res.status];
  return requestAPI({
    method: method,
    url: experiment.installations_url + store.clientUUID
  }).then(done, done);
}

function requestAPI(opts) {
  const reqUrl = new URL(opts.url);

  const headers = {
    // HACK: Use the API origin as Referer to make CSRF checking happy on SSL
    'Referer': reqUrl.origin,
    'Accept': 'application/json',
    'Cookie': ''
  };

  const hostname = settings.HOSTNAME;
  const cookieEnumerator = cookieManager2.getCookiesFromHost(hostname);
  while (cookieEnumerator.hasMoreElements()) {
    const c = cookieEnumerator.getNext().QueryInterface(Ci.nsICookie); // eslint-disable-line new-cap
    headers.Cookie += c.name + '=' + c.value + ';';
    if (c.name === 'csrftoken') {
      headers['X-CSRFToken'] = c.value;
    }
  }

  return new Promise((resolve, reject) => {
    request({
      url: opts.url,
      headers: Object.assign(headers, opts.headers || {}),
      contentType: 'application/json',
      onComplete: res => (res.status < 400) ? resolve(res) : reject(res)
    })[opts.method || 'get']();
  });
}

const addonListener = {
  onEnabled: function(addon) {
    if (isTestpilotAddonID(addon.id)) {
      setAddonActiveState(addon);
      app.send('addon-manage:enabled', {
        id: addon.id,
        name: addon.name,
        version: addon.version
      });
      Metrics.experimentEnabled(addon.id);
      WebExtensionChannels.updateExperimentChannels();
    }
  },
  onDisabled: function(addon) {
    if (isTestpilotAddonID(addon.id)) {
      setAddonActiveState(addon);
      app.send('addon-manage:disabled', {
        id: addon.id,
        name: addon.name,
        version: addon.version
      });
      Metrics.experimentDisabled(addon.id);
      WebExtensionChannels.updateExperimentChannels();
    }
  },
  onUninstalling: function(addon) {
    if (isTestpilotAddonID(addon.id)) {
      app.send('addon-uninstall:uninstall-started', {
        id: addon.id,
        name: addon.name,
        version: addon.version
      });
    }
  },
  onUninstalled: function(addon) {
    if (isTestpilotAddonID(addon.id)) {
      app.send('addon-uninstall:uninstall-ended', {
        id: addon.id,
        name: addon.name,
        version: addon.version
      }, addon);

      setAddonActiveState(addon);
      delete store.installedAddons[addon.id];
      syncAddonInstallation(addon.id);

      Metrics.experimentDisabled(addon.id);
      WebExtensionChannels.updateExperimentChannels();
    }
  }
};
AddonManager.addAddonListener(addonListener);

const installListener = {
  onInstallEnded: function(install, addon) {
    if (!isTestpilotAddonID(addon.id)) { return; }
    setAddonActiveState(addon);
    syncAddonInstallation(addon.id).then(() => {
      app.send('addon-install:install-ended',
               formatInstallData(install, addon), addon);
    });
    Metrics.experimentEnabled(addon.id);
    WebExtensionChannels.updateExperimentChannels();
  },
  onInstallFailed: function(install) {
    app.send('addon-install:install-failed', formatInstallData(install));
  },
  onInstallStarted: function(install) {
    app.send('addon-install:install-started', formatInstallData(install));
  },
  onNewInstall: function(install) {
    app.send('addon-install:install-new', formatInstallData(install));
  },
  onInstallCancelled: function(install) {
    app.send('addon-install:install-cancelled', formatInstallData(install));
  },
  onDownloadStarted: function(install) {
    app.send('addon-install:download-started', formatInstallData(install));
  },
  onDownloadProgress: function(install) {
    app.send('addon-install:download-progress', formatInstallData(install));
  },
  onDownloadEnded: function(install) {
    app.send('addon-install:download-ended', formatInstallData(install));
  },
  onDownloadCancelled: function(install) {
    app.send('addon-install:download-cancelled', formatInstallData(install));
  },
  onDownloadFailed: function(install) {
    app.send('addon-install:download-failed', formatInstallData(install));
  }
};
AddonManager.addInstallListener(installListener);

exports.main = function(options) {
  const reason = options.loadReason;

  if (!store.clientUUID) {
    // Generate a UUID for this client, so we can manage experiment
    // installations for multiple browsers per user. DO NOT USE IN METRICS.
    store.clientUUID = require('sdk/util/uuid').uuid().toString().slice(1, -1);
  }

  if (reason === 'install' || reason === 'enable') {
    Metrics.onEnable();
  }
  updatePrefs();
  initServerEnvironmentPreference();
  Metrics.init();
  WebExtensionChannels.init();
  ToolbarButton.init(settings);
  ExperimentNotifications.init();
};

exports.onUnload = function(reason) {
  AddonManager.removeAddonListener(addonListener);
  AddonManager.removeInstallListener(installListener);
  Metrics.destroy();
  WebExtensionChannels.destroy();
  ToolbarButton.destroy();
  ExperimentNotifications.destroy();

  if (reason === 'uninstall' || reason === 'disable') {
    Metrics.onDisable();
  }

  if (reason === 'uninstall') {
    survey.destroy();
    ExperimentNotifications.uninstall();

    if (store.installedAddons) {
      Object.keys(store.installedAddons).forEach(id => {
        uninstallExperiment({addon_id: id});
      });
      delete store.installedAddons;
    }
    delete store.availableExperiments;

    app.send('addon-self:uninstalled');
  }
  app.destroy();
};
