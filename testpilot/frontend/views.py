from django.shortcuts import render


def index(request, url=''):
    return render(request, 'testpilot/frontend/index.html')
