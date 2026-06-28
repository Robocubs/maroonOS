class Dashboard {
    constructor(printerId, root, { onStateChange } = {}) {
        this.printerId = printerId;
        this.root = root;
        this.onStateChange = onStateChange || null;
        this.isPrinting = false;

        this.liveUpdateInterval = 1000;
        this.sleepUpdateInterval = 2000;
        this.maxBedValue = -1;
        this.maxNozzleValue = -1;
        this.bedIntervalId = null;
        this.nozzleIntervalId = null;
        this.printerType = null;
        this.nozzleSize = null;

        this.xValues = Array.from({ length: 20 }, (_, i) => i);
        this.bedyValues = Array(20).fill(0);
        this.nozzleyValues = Array(20).fill(0);

        this.white = getComputedStyle(document.documentElement).getPropertyValue('--white');
        this.darkgrey = getComputedStyle(document.documentElement).getPropertyValue('--dark-grey');

        this.live = this.$('#live');
        this.sleep = this.$('#sleep');

        this.bedHeatingEls = [1, 2, 3, 4, 5].map(i => this.$(`#bedHeating${i}`));
        this.nozzleHeatingEls = [1, 2, 3, 4, 5].map(i => this.$(`#nozzleHeating${i}`));

        this.$('#progressNotices').style.animation = 'none';
        if (this.sleep) this.sleep.style.display = 'none';
        if (this.live) this.live.style.display = 'none';

        this._initCharts();
        this.mainLoop();
    }

    $(selector) {
        return this.root.querySelector(selector);
    }

    _chartConfig(color, data) {
        const axisStyle = { drawTicks: false, drawOnChartArea: false, drawBorder: true, color, lineWidth: 5 };
        return {
            type: 'line',
            data: {
                labels: this.xValues,
                datasets: [{ borderColor: color, data, tension: 0, pointRadius: 0, fill: false }]
            },
            options: {
                legend: { display: false },
                scales: {
                    yAxes: [{ ticks: { display: false, min: 0, max: 100 }, gridLines: axisStyle }],
                    xAxes: [{ ticks: { display: false }, gridLines: axisStyle }]
                }
            }
        };
    }

    _initCharts() {
        ['#bedChart', '#darkBedChart', '#nozzleChart', '#darkNozzleChart'].forEach(id => {
            const canvas = this.$(id);
            canvas.width = canvas.offsetWidth;
            canvas.height = canvas.offsetHeight;
        });

        this.bedChart = new Chart(this.$('#bedChart'), this._chartConfig(this.white, this.bedyValues));
        this.darkBedChart = new Chart(this.$('#darkBedChart'), this._chartConfig(this.darkgrey, this.bedyValues));
        this.nozzleChart = new Chart(this.$('#nozzleChart'), this._chartConfig(this.white, this.nozzleyValues));
        this.darkNozzleChart = new Chart(this.$('#darkNozzleChart'), this._chartConfig(this.darkgrey, this.nozzleyValues));
    }

    // --- API ---

    getStatus(callback) {
        fetch(`/printer/${this.printerId}/status`)
            .then(r => r.json())
            .then(data => {
                this.$('#hotendFan').textContent = data.printer.fan_hotend;
                this.$('#speed').textContent = Math.ceil(data.printer.speed) + '%';
                this.$('#printFan').textContent = data.printer.fan_print;

                this.$('#nozzleTemp').textContent = Math.ceil(data.printer.temp_nozzle) + '°';
                this.$('#darkNozzleTemp').textContent = Math.ceil(data.printer.temp_nozzle) + '°';
                this.$('#bedTemp').textContent = Math.ceil(data.printer.temp_bed) + '°';
                this.$('#darkBedTemp').textContent = Math.ceil(data.printer.temp_bed) + '°';

                this.$('#nozzleTarget').textContent = '/ ' + Math.ceil(data.printer.target_nozzle) + '°';
                this.$('#darkNozzleTarget').textContent = '/ ' + Math.ceil(data.printer.target_nozzle) + '°';
                this.$('#bedTarget').textContent = '/ ' + Math.ceil(data.printer.target_bed) + '°';
                this.$('#darkBedTarget').textContent = '/ ' + Math.ceil(data.printer.target_bed) + '°';

                this._checkNozzleHeating(data.printer.temp_nozzle, data.printer.target_nozzle);
                this._checkBedHeating(data.printer.temp_bed, data.printer.target_bed);
                this._updateNozzleGraph(data.printer.temp_nozzle);
                this._updateBedGraph(data.printer.temp_bed);
                callback(data.printer.state);
            })
            .catch(() => callback('IDLE'));
    }

    getJobStatic() {
        fetch(`/printer/${this.printerId}/job`)
            .then(r => r.json())
            .then(data => {
                const fileName = data.file.display_name.split('_');
                if (this.printerType === 'connect.prusa3d.com') {
                    this._checkLength(this._checkIS(fileName)[0]);
                    this.$('#filamentType').textContent = fileName[2];
                    this.$('#layerHeight').textContent = fileName[1].replace('mm', '');
                    this.$('#layerUnit').textContent = 'mm';
                    this.$('#nozzleDiameter').textContent = this.nozzleSize;
                    this.$('#nozzleUnit').textContent = 'mm';
                    this.$('#timeString').innerHTML = this._calcTime(fileName[4].split('.')[0]);
                } else {
                    this._checkLength(this._checkIS(fileName)[0]);
                    this.$('#filamentType').textContent = fileName[3];
                    this.$('#layerHeight').textContent = fileName[2].replace('mm', '');
                    this.$('#layerUnit').textContent = 'mm';
                    this.$('#nozzleDiameter').textContent = fileName[1].replace('n', '');
                    this.$('#nozzleUnit').textContent = 'mm';
                    this.$('#timeString').innerHTML = this._calcTime(fileName[5].split('.')[0]);
                }
            })
            .catch(() => {});
    }

    getJobDynamic() {
        fetch(`/printer/${this.printerId}/job`)
            .then(r => r.json())
            .then(data => {
                this._updateProgressBar(data.progress);
                this._updateProgressNotices(data);
                this._shrinkText('#timeRemaining');
                this._shrinkText('#timeElapsed');
            })
            .catch(() => {});
    }

    getInfo() {
        fetch(`/printer/${this.printerId}/info`)
            .then(r => r.json())
            .then(data => {
                this.$('#printerName').textContent = data.name;
                this.$('#firmwareVersion').textContent = 'FW ' + data.firmware;
            })
            .catch(() => {});
    }

    getMachineInfo() {
        fetch(`/printer/${this.printerId}/machineInfo`)
            .then(r => r.json())
            .then(data => {
                this.printerType = data.hostname;
                if (this.printerType === 'connect.prusa3d.com') {
                    this.nozzleSize = data.nozzle_diameter;
                }
            })
            .catch(() => {});
    }

    getThumbnail() {
        fetch(`/printer/${this.printerId}/thumbnail`)
            .then(r => r.json())
            .then(data => {
                const view = this.$('#thumbnail');
                const image = `data:image/png;base64,${data.image}`;
                const size = new Image();
                size.src = image;
                size.onload = () => {
                    if (size.width !== 999 || size.height !== 999) {
                        view.style.width = '90%';
                        view.style.height = '90%';
                        view.src = '/static/images/RobocubsLogo.png';
                    } else {
                        view.src = image;
                    }
                };
            })
            .catch(() => {
                const view = this.$('#thumbnail');
                view.style.width = '90%';
                view.style.height = '90%';
                view.src = '/static/images/RobocubsLogo.png';
            });
    }

    // --- Main loop ---

    mainLoop() {
        this.getStatus(state => {
            if (state === 'PRINTING') {
                this._onPrinting();
                const printingLoop = () => {
                    this.getStatus(s => {
                        this.getJobDynamic();
                        if (s === 'PRINTING') {
                            setTimeout(printingLoop, this.liveUpdateInterval);
                        } else {
                            this._onIdle();
                            setTimeout(() => this.mainLoop(), this.sleepUpdateInterval);
                        }
                    });
                };
                printingLoop();
            } else {
                this._onIdle();
                setTimeout(() => this.mainLoop(), this.sleepUpdateInterval);
            }
        });
    }

    _onPrinting() {
        if (!this.isPrinting) {
            this.getThumbnail();
            this.getJobStatic();
            this.getInfo();
            this.getMachineInfo();
        }
        this.isPrinting = true;
        this._updateDate();
        if (this.live) this.live.style.display = '';
        if (this.sleep) this.sleep.style.display = 'none';
        if (this.onStateChange) this.onStateChange(true);
    }

    _onIdle() {
        this.isPrinting = false;
        if (this.live) this.live.style.display = 'none';
        if (this.sleep) this.sleep.style.display = '';
        if (this.onStateChange) this.onStateChange(false);
    }

    // --- UI helpers ---

    _checkLength(title) {
        this.$('#jobTitle').style.display = 'none';
        this.$('#scrollTitle').style.display = 'none';
        this.$('#jobTitle1').style.animation = 'none';
        this.$('#jobTitle2').style.animation = 'none';
        if (title.length > 28) {
            this.$('#jobTitle1').textContent = title;
            this.$('#jobTitle2').textContent = title;
            this.$('#scrollTitle').style.display = '';
            this.$('#jobTitle1').style.animation = '';
            this.$('#jobTitle2').style.animation = '';
        } else {
            this.$('#jobTitle').textContent = title;
            this.$('#jobTitle').style.display = '';
        }
    }

    _checkIS(title) {
        if (title[4] === 'MK4IS' || title[4] === 'XLIS') {
            this.$('#ISLabel').textContent = 'On';
        } else if (title[3] === 'MK3S') {
            this.$('#ISLabel').textContent = '---';
        } else {
            this.$('#ISLabel').textContent = 'Off';
        }
        return title;
    }

    _calcTime(time) {
        if (time.includes('s')) return time.replace('s', ' seconds');
        const hasDays = time.includes('d');
        const hasHours = time.includes('h');
        const hasMins = time.includes('m');
        const parts = time.replace(/[dhm]/g, '_').split('_');
        const fmt = (n, s, p) => n == 1 ? `${n} ${s}` : `${n} ${p}`;
        const segments = [];
        let i = 0;
        if (hasDays) segments.push(fmt(parts[i++], 'day', 'days'));
        if (hasHours) segments.push(fmt(parts[i++], 'hr', 'hrs'));
        if (hasMins) segments.push(fmt(parts[i++], 'min', 'mins'));
        return segments.join('<br>');
    }

    _updateProgressBar(progress) {
        if (!progress) progress = 0;
        if (progress >= 3) {
            this.$('.progress-bar-fill').style.width = progress + '%';
        }
    }

    _updateProgressNotices(data) {
        this.$('#progressNotices').style.animation = '';
        this.$('#percent').textContent = Math.ceil(data.progress) + '% complete';
        this.$('#timeRemaining').textContent = this._timeString(data.time_remaining) + ' remaining';
        this.$('#timeElapsed').textContent = this._timeString(data.time_printing) + ' elapsed';
        this.$('#percent1').textContent = Math.ceil(data.progress) + '% complete';
    }

    _timeString(time) {
        const days = Math.floor(time / 86400);
        time -= days * 86400;
        const hours = Math.floor(time / 3600);
        time -= hours * 3600;
        const minutes = Math.floor(time / 60);
        const fmt = (n, s, p) => n === 1 ? `${n} ${s}` : `${n} ${p}`;
        const parts = [];
        if (days) parts.push(fmt(days, 'day', 'days'));
        if (hours) parts.push(fmt(hours, 'hr', 'hrs'));
        if (minutes) parts.push(fmt(minutes, 'min', 'mins'));
        if (!parts.length) return `${time} seconds`;
        if (parts.length === 1) return parts[0];
        if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
        return `${parts[0]}, ${parts[1]}, and ${parts[2]}`;
    }

    _shrinkText(selector) {
        const el = this.$(selector);
        const parent = el.parentElement;
        let fontSize = parseFloat(getComputedStyle(el).fontSize);
        while (el.scrollWidth > parent.offsetWidth) {
            fontSize--;
            el.style.fontSize = fontSize + 'px';
        }
    }

    _updateDate() {
        const now = new Date();
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        const dayFontSizes = ['75', '75', '70', '50', '65', '75', '70'];

        const hours = now.getHours();
        const ampm = hours >= 12 ? 'PM' : 'AM';
        const displayHours = hours % 12 || 12;
        const minutes = String(now.getMinutes()).padStart(2, '0');

        this.$('#currentTime').textContent = `${displayHours}:${minutes} ${ampm}`;
        this.$('#dow').style.fontSize = dayFontSizes[now.getDay()] + 'px';
        this.$('#dow').textContent = days[now.getDay()];
        this.$('#date').textContent = months[now.getMonth()] + ' ' + now.getDate();
        this.$('#year').textContent = now.getFullYear();
    }

    _updateBedGraph(data) {
        if (this.bedyValues.every(v => v === 0)) {
            this.bedyValues.fill(data);
        } else {
            this.bedyValues.shift();
            this.bedyValues.push(data);
        }
        if (data > this.maxBedValue) {
            this.maxBedValue = data;
            this.bedChart.options.scales.yAxes[0].ticks.max = this.maxBedValue + 5;
            this.darkBedChart.options.scales.yAxes[0].ticks.max = this.maxBedValue + 5;
        }
        if (!this.bedyValues.includes(this.maxBedValue)) {
            this.maxBedValue = Math.max(...this.bedyValues) + 5;
            this.bedChart.options.scales.yAxes[0].ticks.max = this.maxBedValue;
            this.darkBedChart.options.scales.yAxes[0].ticks.max = this.maxBedValue;
        }
        this.bedChart.update();
        this.darkBedChart.update();
    }

    _updateNozzleGraph(data) {
        if (this.nozzleyValues.every(v => v === 0)) {
            this.nozzleyValues.fill(data);
        } else {
            this.nozzleyValues.shift();
            this.nozzleyValues.push(data);
        }
        if (data > this.maxNozzleValue) {
            this.maxNozzleValue = data;
            this.nozzleChart.options.scales.yAxes[0].ticks.max = this.maxNozzleValue + 10;
            this.darkNozzleChart.options.scales.yAxes[0].ticks.max = this.maxNozzleValue + 10;
        }
        if (!this.nozzleyValues.includes(this.maxNozzleValue)) {
            this.maxNozzleValue = Math.max(...this.nozzleyValues) + 10;
            this.nozzleChart.options.scales.yAxes[0].ticks.max = this.maxNozzleValue;
            this.darkNozzleChart.options.scales.yAxes[0].ticks.max = this.maxNozzleValue;
        }
        this.nozzleChart.update();
        this.darkNozzleChart.update();
    }

    _checkNozzleHeating(current, target) {
        const heating = current < target - 2;
        this.$('#nozzleHeating').style.opacity = heating ? 1 : 0;
        this.$('#nozzleStable').style.opacity = heating ? 0 : 1;
        if (heating) this._nozzleStartHeating(); else this._nozzleStopHeating();
    }

    _checkBedHeating(current, target) {
        const heating = current < target - 1;
        this.$('#bedHeating').style.opacity = heating ? 1 : 0;
        this.$('#bedStable').style.opacity = heating ? 0 : 1;
        if (heating) this._bedStartHeating(); else this._bedStopHeating();
    }

    _bedStartHeating() {
        if (this.bedIntervalId) return;
        this._bedAnimateGradient();
        this.bedIntervalId = setInterval(() => this._bedAnimateGradient(), 2000);
    }

    _bedStopHeating() {
        clearInterval(this.bedIntervalId);
        this.bedIntervalId = null;
    }

    _nozzleStartHeating() {
        if (this.nozzleIntervalId) return;
        this._nozzleAnimateGradient();
        this.nozzleIntervalId = setInterval(() => this._nozzleAnimateGradient(), 2000);
    }

    _nozzleStopHeating() {
        clearInterval(this.nozzleIntervalId);
        this.nozzleIntervalId = null;
    }

    _animateGradient(els) {
        const v = 250;
        els.forEach(el => {
            const x = Math.floor(Math.random() * 600) - 300;
            const y = Math.floor(Math.random() * v * 2) - v;
            el.style.transform = `translate3d(${x}px, ${y}px, 0px)`;
        });
    }

    _bedAnimateGradient() { this._animateGradient(this.bedHeatingEls); }
    _nozzleAnimateGradient() { this._animateGradient(this.nozzleHeatingEls); }
}
