import requests
import random
import sys
from flask_cors import CORS
from flask import Flask, jsonify
from dotenv import load_dotenv
import os
import base64

global devMode, status, job, info, version, apiKey, count, printerInfo

# Load environment variables
def loadEnv(path):
    global ipAddress, apiKey, printerInfo

    load_dotenv(dotenv_path=f"../.env.{path}", override=True)

    ipAddress = os.getenv('IP')
    apiKey = os.getenv('API_KEY')
    printerInfo = {
        "name": os.getenv('PRINTER_NAME'),
        "firmware": os.getenv('FIRMWARE'),
    }

count = 0       # Used in dev mode to cycle through different states

devMode = os.getenv('DEV_MODE', 'false').lower() == 'true'
cycleStates = False  # Set to True to cycle through different printer states when dev mode is True

status = {
    "job": {
        "id":43, 
        "progress": 28.00, 
        "time_remaining": 7560, 
        "time_printing": 3302
    }, 
    "storage": {
        "path": "/usb/", 
        "name": "usb", 
        "read_only": "false"
    }, 
    "printer": {
        "state": "PRINTING",
        "temp_bed": 60.0,
        "target_bed": 60.0,
        "temp_nozzle": 220.1,
        "target_nozzle": 220.0,
        "axis_z":4.3, 
        "flow": 100,
        "speed": 100, 
        "fan_hotend": 4098,
        "fan_print": 6314,
    }
}

job = {
    "id": 43,
    "state": "PRINTING",
    "progress": 30.00,
    "time_remaining": 7440,
    "time_printing": 3472,
    "file": {
        "refs": {
            "icon": "/thumb/s/usb/AMPSTA~1.BGC",
            "thumbnail": "/thumb/l/usb/AMPSTA~1.BGC",
            "download": "/usb/AMPSTA~1.BGC",
        },
        "name":"AMPSTA~1.BGC",
        "display_name": "BigHook_0.2mm_PETG_MK3S_54m.gcode",
        "path": "/usb",
        "size":0,
        "m_timestamp": 1704831009,
    }
}

machineInfo = {
    "name": "Prusa MK3 [A]",
    "location": "Robotics Lab",
    "farm_mode": "false",
    "network_error_chime": "false",
    "nozzle_diameter": 0.4,
    "min_extrusion_temp": 170,
    "serial": "CZPX0019X004XK01387",
    "hostname": "connect.prusa3d.com",
    "port": 0
}

app = Flask(__name__)
CORS(app)

def liveProgress():
    return random.uniform(0, 100)

def liveFan():
    return random.randint(0, 4000)

def liveNozzle():
    return random.uniform(20, 230)

def liveBed():
    return random.uniform(20, 80)

@app.route('/')
def hello():
    return printerInfo["name"]

@app.route('/status')
def getStatus():
    global count, ipAddress
    if devMode:
        if cycleStates:
            count += 1
            if count == 3:
                status['printer']['state'] = 'PRINTING'
            elif count == 6:
                status['printer']['state'] = 'IDLE'
                count = 0
        status['printer']['temp_nozzle'] = liveNozzle()
        status['printer']['temp_bed'] = liveBed()
        status['printer']['target_nozzle'] = liveNozzle()
        status['printer']['target_bed'] = liveBed()
        status['printer']['speed'] = liveProgress()
        status['printer']['fan_hotend'] = liveFan()
        status['printer']['fan_print'] = liveFan()
        return jsonify(status)
    else:
        headers = {'X-Api-Key': apiKey}
        response = requests.get(f'http://{ipAddress}/api/v1/status', headers=headers)
        return response.text
    
@app.route('/job')
def getJob():
    global ipAddress
    if devMode:
        job['progress'] = liveProgress()
        job['time_remaining'] = 12
        job['time_printing'] = 123
        return jsonify(job)
    else:
        headers = {'X-Api-Key': apiKey}
        response = requests.get(f'http://{ipAddress}/api/v1/job', headers=headers)
        return response.text

@app.route('/info')
def getInfo():
    return jsonify(printerInfo)

@app.route('/machineInfo')
def getMachineInfo():
    if devMode:
        return jsonify(machineInfo)
    else:
        headers = {'X-Api-Key': apiKey}
        response = requests.get(f'http://{ipAddress}/api/v1/info', headers=headers)
        return response.text

    
@app.route('/thumbnail')
def getThumbnail():
    if devMode:
        # return send_file('../frontends/assets/RobocubsLogo.png', mimetype='image/png')
        try:
            with open(os.path.join(os.path.dirname(__file__), 'ThumbnailDemo.png'), 'rb') as f:
                image_data = f.read()
            encoded_image = base64.b64encode(image_data).decode('utf-8')
            return jsonify({'image': encoded_image})
        except Exception as e:
            return jsonify({'error': 'Error reading local image'}), 500
    else:
        headers = {'X-Api-Key': apiKey}
        try:
            response = requests.get(f'http://{ipAddress}/api/v1/job', headers=headers)
            if response.status_code != 200:
                return
            
            response_json = response.json()
            imagePath = response_json['file']['refs']['thumbnail']
            image_response = requests.get(f'http://{ipAddress}{imagePath}', headers=headers)
            if image_response.status_code != 200:
                return

            image_data = image_response.content
            encoded_image = base64.b64encode(image_data).decode('utf-8')
            return jsonify({'image': encoded_image})
        except Exception as e:
            return

if __name__ == '__main__':
    from waitress import serve

    if len(sys.argv) > 1:
        port = int(sys.argv[1])
    else:
        port = 8002

    loadEnv(str(port)[-1])

    serve(app, host="0.0.0.0", port=port)