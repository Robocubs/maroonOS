# About<br>
maroonOS is a custom-built dashboard for Prusa machines using Prusa Link/Prusa Connect. It was developed as a replacement for [OctoDash](https://github.com/UnchartedBull/OctoDash) after moving from [OctoPrint](https://octoprint.org/) to [Prusa Connect](https://connect.prusa3d.com/). To pull data from the printer(s), the [Prusa Link API](https://github.com/prusa3d/Prusa-Link-Web/blob/master/spec/openapi.yaml) is used. This project is still in development with new features in the works (a timeline for expected features will be added soon). To get this running on your own Raspberry Pi, you can just follow the raspiConfigInstructions.txt file. 
<br><br>*NOTE: This project was developed to run on a 1440 x 2560 portrait monitor. Your mileage may vary if running at a different resolution/size.*
# How it Works<br>
maroonOS is comprised of two main parts; the server backend and the GUI frontends. Both are required to be running for the dashboard to function correctly.
## Backend<br>
Two servers are running behind the scenes to orchestrate communication with the printer and manage a separate settings page. Both servers are built in Python with [Flask](https://flask.palletsprojects.com/en/2.3.x/) as the server framework and [Waitress](https://flask.palletsprojects.com/en/2.3.x/deploying/waitress/) as the WSGI (Web Server Gateway Interface). Both servers are started when the Raspberry Pi boots up and then they wait for a request. 
#### Main Server<br>
The main server is contained in the server.py file. It waits for a fetch request from JavaScript that is sent through an internal IP address. When receiving a request, it matches it with the correct route and then follows the associated function to get information from the printer. The call to the printer is authenticated by attaching the X-Api-Key header to the request. This value is the API key from Prusa Link.
#### Settings Server<br>
A settings server is currently in development. Its goal is to allow for an easier way to customize parts of the dashboard (the sleep screen image or video (planned feature) for example). It will be served up by the second Python server in the settingsServer.py file. *More information to come.*
## frontends<br>
The frontends are built in HTML, CSS, and JavaScript which is running on Chromium in kiosk mode. The dashboard.html file is the main view that is displayed when the printer is running. Its supporting files are dashboardLoop.js and dashboardStyles.css. The sleep.html file is the sleep screen that is displayed when the printer is idle or disconnected. Its supporting files are sleepLoop.js and sleepStyles.css. There are some additional frontends files that aid in the operation of the frontends across the board to create a unified color scheme, font family, interface startup, and asset library. 
<br><br>*Developed for FRC Team 1701 - Robocubs*

## Config Dashboard<br>
maroonOS includes a built-in configuration dashboard accessible at `http://<pi-ip>:8080/config` (or `http://localhost:8080/config` locally). It provides a graphical interface to manage everything that previously required SSH access.

**What it manages:**
- **Printers** — Set the name, firmware version, IP address, and API key for each printer slot (1–3). Changes take effect immediately without a server restart. Use "Test Connection" to verify connectivity before saving.
- **Media Library** — Upload images and videos to use as screensaver content. Drag-and-drop or click to upload. Supports jpg/jpeg/png/gif/webp for images and mp4/webm/mov for videos.
- **Playlist** — Build and reorder the screensaver playlist for the idle screen. Drag items to reorder. Set display duration for images. Changes auto-save on reorder; use "Save Playlist" to commit manually.

**Persistence:**
Printer config is stored in `app/config/printers.json`. Playlists are stored in `app/config/playlist_reg.json` and `app/config/playlist_max.json`. On first boot, existing `.env.N` files are automatically migrated to `printers.json`.

**Required docker-compose volume mounts** (add to your compose file if not present):
```yaml
volumes:
  - ./app/config:/app/config          # printer config + playlists
  - ./app/static/videos:/app/static/videos   # uploaded videos
  - ./app/static/images:/app/static/images   # uploaded images
```
