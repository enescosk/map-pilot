#!/usr/bin/env python3
"""Generic ROS -> MQTT bridge for MapPilot backend.

Reads a topic list from the ~topics param (yaml list of {topic, type}).
For each topic, subscribes and publishes JSON envelopes to
  map-pilot/raw/<topic_without_leading_slash>
in the format expected by server/sources/mqttBridgeSource.js.
"""
import importlib
import json
import rospy
import paho.mqtt.client as mqtt
from rosbridge_library.internal.message_conversion import extract_values

MQTT_HOST = rospy.get_param("/mqtt_host", "localhost") if False else "localhost"
MQTT_PORT = 1883
TOPIC_ROOT = "map-pilot"

# topic_type strings expected by backend (matches dbw_interface/* and sensor_msgs/*)
DEFAULT_TOPICS = [
    {"topic": "/VelocityInformation",    "type": "dbw_interface/VelocityInformation"},
    {"topic": "/eps_response",           "type": "dbw_interface/EPS_Response"},
    {"topic": "/EHB_BrakingResponse",    "type": "dbw_interface/EHB_BrakingResponse"},
    {"topic": "/fb_motor_driver_report", "type": "dbw_interface/FB_MotorDriver"},
    {"topic": "/rc_unit_report",         "type": "dbw_interface/FB_OMUX_to_AUTONOMOUS"},
    {"topic": "/autonomous_report",      "type": "dbw_interface/AutonomousHeardBit"},
]

mqtt_client = mqtt.Client()


def load_msg_class(type_str):
    pkg, msg = type_str.split("/")
    mod = importlib.import_module(f"{pkg}.msg")
    return getattr(mod, msg)


def make_callback(topic, type_str):
    mqtt_topic = f"{TOPIC_ROOT}/raw{topic}"

    def cb(msg):
        envelope = {
            "topic": topic,
            "type": type_str,
            "time": f"{rospy.get_time():.6f}",
            "message": extract_values(msg),
        }
        mqtt_client.publish(mqtt_topic, json.dumps(envelope))
        rospy.loginfo_throttle(2.0, f"-> {mqtt_topic}")

    return cb


def main():
    rospy.init_node("ros_to_mqtt_bridge")
    mqtt_client.connect(MQTT_HOST, MQTT_PORT, 60)
    mqtt_client.loop_start()

    topics = rospy.get_param("~topics", DEFAULT_TOPICS)
    for entry in topics:
        cls = load_msg_class(entry["type"])
        rospy.Subscriber(entry["topic"], cls, make_callback(entry["topic"], entry["type"]))
        rospy.loginfo(f"subscribed {entry['topic']} ({entry['type']})")

    rospy.loginfo(f"bridge active on mqtt://{MQTT_HOST}:{MQTT_PORT}/{TOPIC_ROOT}/raw/#")
    rospy.spin()
    mqtt_client.loop_stop()
    mqtt_client.disconnect()


if __name__ == "__main__":
    main()
