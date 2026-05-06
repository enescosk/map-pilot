import { SerialPort } from "serialport";

const SERIAL_PATH = process.env.SERIAL_PORT || "/dev/ttyUSB0";
const BAUD_RATE = Number(process.env.BAUD_RATE || 115200);
const MOTOR_START_DTR = process.env.MOTOR_START_DTR === "true";
const MOTOR_START_RTS = process.env.MOTOR_START_RTS === "true";
const RPLIDAR_SCAN_COMMAND = Buffer.from([0xa5, 0x20]);
const RPLIDAR_STOP_COMMAND = Buffer.from([0xa5, 0x25]);

export function createDirectLidarSource({ emit }) {
  let serial;
  let textBuffer = "";
  let binaryBuffer = Buffer.alloc(0);
  let motorRunning = false;
  let latestReadings = [];

  function emitStatus() {
    emit({
      type: "status",
      connected: motorRunning,
      source: "direct-serial",
    });
  }

  function getStatus() {
    return {
      type: "status",
      connected: motorRunning,
      source: "direct-serial",
    };
  }

  function parseLine(line) {
    const tokens = line
      .trim()
      .split(/[\s,;]+/)
      .map((segment) => Number(segment.trim()))
      .filter((value) => !Number.isNaN(value));

    const readings = [];
    for (let i = 0; i + 1 < tokens.length; i += 2) {
      readings.push({ angle: tokens[i], distance: tokens[i + 1] });
    }

    return readings;
  }

  function parseRplidarMeasurements(chunk) {
    binaryBuffer = Buffer.concat([binaryBuffer, chunk]);

    // Drop the RPLIDAR response descriptor before reading 5-byte measurements.
    const descriptorIndex = binaryBuffer.indexOf(Buffer.from([0xa5, 0x5a]));
    if (descriptorIndex >= 0 && binaryBuffer.length >= descriptorIndex + 7) {
      binaryBuffer = binaryBuffer.subarray(descriptorIndex + 7);
    }

    const readings = [];

    while (binaryBuffer.length >= 5) {
      const syncQuality = binaryBuffer[0];
      const angleCheck = binaryBuffer.readUInt16LE(1);
      const distanceQ2 = binaryBuffer.readUInt16LE(3);
      const startBit = syncQuality & 0x01;
      const inverseStartBit = (syncQuality >> 1) & 0x01;
      const hasGoodSync = startBit !== inverseStartBit;
      const hasCheckBit = (angleCheck & 0x01) === 1;

      if (!hasGoodSync || !hasCheckBit) {
        binaryBuffer = binaryBuffer.subarray(1);
        continue;
      }

      const quality = syncQuality >> 2;
      const angle = (angleCheck >> 1) / 64;
      const distance = distanceQ2 / 4000;

      if (quality > 0 && distance > 0) {
        readings.push({
          angle: Number(angle.toFixed(1)),
          distance: Number(distance.toFixed(3)),
        });
      }

      binaryBuffer = binaryBuffer.subarray(5);
    }

    return readings;
  }

  function parseTextMeasurements(chunk) {
    textBuffer += chunk.toString("utf8");

    const readings = [];
    let newlineIndex;
    while ((newlineIndex = textBuffer.indexOf("\n")) >= 0) {
      const line = textBuffer.slice(0, newlineIndex);
      textBuffer = textBuffer.slice(newlineIndex + 1);
      readings.push(...parseLine(line));
    }

    return readings;
  }

  function publishReadings(readings) {
    latestReadings = readings;
    emit({
      type: "scan",
      readings: latestReadings,
      source: "direct-serial",
    });
  }

  function handleScanData(chunk) {
    const binaryReadings = parseRplidarMeasurements(chunk);

    if (binaryReadings.length > 0) {
      publishReadings([...latestReadings, ...binaryReadings].slice(-180));
      return;
    }

    const textReadings = parseTextMeasurements(chunk);
    if (textReadings.length > 0) {
      publishReadings(textReadings);
    }
  }

  function sendLidarCommand(command, label) {
    if (!serial?.isOpen) {
      return;
    }

    serial.write(command, (error) => {
      if (error) {
        console.error(`Failed to send ${label} command:`, error.message);
        return;
      }

      console.log(`Sent ${label} command`);
    });
  }

  function setMotorSignals(isRunning) {
    if (!serial?.isOpen) {
      return;
    }

    // This adapter is active-low: false/false starts the motor, true/true stops it.
    const dtr = isRunning ? MOTOR_START_DTR : !MOTOR_START_DTR;
    const rts = isRunning ? MOTOR_START_RTS : !MOTOR_START_RTS;

    console.log(`LiDAR motor ${isRunning ? "start" : "stop"} signals: DTR=${dtr}, RTS=${rts}`);

    serial.set({ dtr, rts }, (error) => {
      if (error) {
        console.error("Failed to set LiDAR motor signals:", error.message);
      }
    });

    motorRunning = isRunning;
    emitStatus();
  }

  function startScanning() {
    latestReadings = [];
    binaryBuffer = Buffer.alloc(0);
    textBuffer = "";
    setMotorSignals(true);

    // RPLIDAR-compatible units need this command before they stream measurements.
    setTimeout(() => sendLidarCommand(RPLIDAR_SCAN_COMMAND, "RPLIDAR scan start"), 300);
  }

  function stopScanning() {
    sendLidarCommand(RPLIDAR_STOP_COMMAND, "RPLIDAR stop");
    setMotorSignals(false);
  }

  function openSerialPort(shouldStartMotor) {
    if (serial?.isOpen) {
      if (shouldStartMotor) {
        startScanning();
      } else {
        stopScanning();
      }
      return;
    }

    serial = new SerialPort({ path: SERIAL_PATH, baudRate: BAUD_RATE, autoOpen: false });

    serial.on("open", () => {
      console.log(`Serial port opened on ${SERIAL_PATH} at ${BAUD_RATE} baud`);
      if (shouldStartMotor) {
        startScanning();
      } else {
        stopScanning();
      }
    });

    serial.on("data", (chunk) => {
      handleScanData(chunk);
    });

    serial.on("error", (error) => {
      console.error("Serial error:", error.message);
      motorRunning = false;
      emitStatus();
    });

    serial.on("close", () => {
      console.log("Serial port closed");
      motorRunning = false;
      emitStatus();
    });

    serial.open((error) => {
      if (error) {
        console.error("Failed to open serial port:", error.message);
        emitStatus();
      }
    });
  }

  function start() {
    openSerialPort(true);
  }

  function stop() {
    if (serial?.isOpen) {
      // Keep the port open so stop DTR/RTS levels stay applied to the adapter.
      stopScanning();
    } else {
      openSerialPort(false);
    }
  }

  return {
    getStatus,
    start,
    stop,
  };
}
