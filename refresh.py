import sys
import splunklib.client as client
import getpass

splunkServer = "localhost"
splunkAdmin = "daniel"
#splunkAdmin = "admin"
#splunkPassword = "c3pcdJQtQACEVb7M73RMRGabH"
splunkPassword = "iPhone123!"
#splunkPassword = "password"
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
