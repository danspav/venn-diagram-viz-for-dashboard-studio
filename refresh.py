import sys
import socket
import splunklib.client as client
import getpass

splunkServer = "localhost"

if socket.gethostname().lower() == "cannonst":
    splunkAdmin = "daniel"
    splunkPassword = "iPhone123!"
else:
    splunkAdmin = "admin"
    splunkPassword = "password"

splunkDestApp = "venn_diagram_viz_for_dashboard_studio"

if splunkDestApp:
    splunkService = client.connect(host=splunkServer, port=8089, username=splunkAdmin, password=splunkPassword, app=splunkDestApp)
else:
    splunkService = client.connect(host=splunkServer, port=8089, username=splunkAdmin, password=splunkPassword)

print('Refreshing app entity...')

applications = splunkService.apps

for app in applications:
    if splunkDestApp:
        if app.name == splunkDestApp:
            try:
                app.refresh()
                app.reload()
                print(splunkDestApp+' has been refreshed')
            except  EntityDeletedException:
                print('Application '+splunkDestApp+' does not exist.')
