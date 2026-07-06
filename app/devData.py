import random


def fake_status() -> dict:
    printing = random.random() < 0.5
    state = "PRINTING"
    state = "PRINTING" if printing else "IDLE"      # Comment out to simulate a printer that is always printing
    return {
        "job": {
            "id": 43,
            "progress": 28.00,
            "time_remaining": random.randint(600, 14400),
            "time_printing": random.randint(60, 7200),
        },
        "storage": {
            "path": "/usb/",
            "name": "usb",
            "read_only": "false",
        },
        "printer": {
            "state": state,
            "temp_bed": round(random.uniform(20, 80), 1),
            "target_bed": 60.0 if printing else 0.0,
            "temp_nozzle": round(random.uniform(20, 230), 1),
            "target_nozzle": 220.0 if printing else 0.0,
            "axis_z": 4.3,
            "flow": 100,
            "speed": round(random.uniform(0, 100), 1),
            "fan_hotend": random.randint(0, 4000),
            "fan_print": random.randint(0, 4000),
        },
    }


def fake_job() -> dict:
    return {
        "id": 43,
        "state": "PRINTING",
        "progress": round(random.uniform(0, 100), 2),
        "time_remaining": random.randint(600, 14400),
        "time_printing": random.randint(60, 7200),
        "file": {
            "refs": {
                "icon": "/thumb/s/usb/AMPSTA~1.BGC",
                "thumbnail": "/thumb/l/usb/AMPSTA~1.BGC",
                "download": "/usb/AMPSTA~1.BGC",
            },
            "name": "AMPSTA~1.BGC",
            "display_name": "3DBenchy3DBenchy3DBenchy3DBenchy3DBenchy3DBenchy3DBenchy_0.6n_0.2mm_PETG_MK4S_47m.bgcode",
            "path": "/usb",
            "size": 0,
            "m_timestamp": 1704831009,
        },
    }


def fake_machine_info() -> dict:
    return {
        "name": "Prusa MK3 [A]",
        "location": "Robotics Lab",
        "farm_mode": "false",
        "network_error_chime": "false",
        "nozzle_diameter": 0.4,
        "min_extrusion_temp": 170,
        "serial": "CZPX0019X004XK01387",
        "hostname": "connect.prusa3d.com",
        "port": 0,
    }
