#!/usr/bin/env python3
import json
import rospy
import paho.mqtt.client as mqtt
from dbw_interface.msg import VelocityInformation

MQTT_HOST = "localhost"
MQTT_PORT = 1883
MQTT_TOPIC = "map-pilot/vehicle/speed"

mqtt_client = mqtt.Client()

def on_velocity(msg):
    payload = json.dumps({
        "speed_ms": msg.VelocityMS,
        "speed_kmh": msg.VelocityKMH,
        "stamp": rospy.get_time(),
    })
    mqtt_client.publish(MQTT_TOPIC, payload)
    rospy.loginfo_throttle(1.0, f"published {payload}")

def main():
    rospy.init_node("velocity_to_mqtt")
    mqtt_client.connect(MQTT_HOST, MQTT_PORT, 60)
    mqtt_client.loop_start()
    rospy.Subscriber("/VelocityInformation", VelocityInformation, on_velocity)
    rospy.loginfo(f"bridging /VelocityInformation -> mqtt://{MQTT_HOST}:{MQTT_PORT}/{MQTT_TOPIC}")
    rospy.spin()
    mqtt_client.loop_stop()
    mqtt_client.disconnect()

if __name__ == "__main__":
    main()
