#!/bin/sh
cd /home/robocubs/maroonOS/server
sudo PYTHONPATH="/home/robocubs/maroonOS/server/venv/lib/python3.11/site-packages" /usr/bin/python3 /home/robocubs/maroonOS/server/maxServerController.py &
# sudo PYTHONPATH="/home/robocubs/maroonOS/server/venv/lib/python3.11/site-packages" /usr/bin/python3 /home/robocubs/maroonOS/server/settingsServer.py &
cd /