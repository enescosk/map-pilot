#!/usr/bin/env python3
"""Generic ROS -> MQTT bridge for MapPilot backend.

Subscribes to a configurable list of ROS topics (vehicle CAN + standard
sensors) and publishes JSON envelopes to map-pilot/raw/<topic> in the format
expected by server/sources/mqttBridgeSource.js.

Skip topics that aren't being published yet — saves a noisy log when only
one bag (vehicle-only or sensor-only) is playing.
"""
import importlib
import json
import rospy
import paho.mqtt.client as mqtt
from rosbridge_library.internal.message_conversion import extract_values

MQTT_HOST = "localhost"
MQTT_PORT = 1883
TOPIC_ROOT = "map-pilot"

DEFAULT_TOPICS = [
    # vehicle CAN feedback (aractan.bag)
    {"topic": "/VelocityInformation",    "type": "dbw_interface/VelocityInformation"},
    {"topic": "/eps_response",           "type": "dbw_interface/EPS_Response"},
    {"topic": "/EHB_BrakingResponse",    "type": "dbw_interface/EHB_BrakingResponse"},
    {"topic": "/fb_motor_driver_report", "type": "dbw_interface/FB_MotorDriver"},
    {"topic": "/rc_unit_report",         "type": "dbw_interface/FB_OMUX_to_AUTONOMOUS"},
    {"topic": "/autonomous_report",      "type": "dbw_interface/AutonomousHeardBit"},
    # standard sensors (2025-07-21-16-53-56.bag etc.)
    {"topic": "/left_laser/scan",        "type": "sensor_msgs/LaserScan"},
    {"topic": "/right_laser/scan",       "type": "sensor_msgs/LaserScan"},
    {"topic": "/m1/rslidar_points",      "type": "sensor_msgs/PointCloud2"},
    {"topic": "/helios/rslidar_points",  "type": "sensor_msgs/PointCloud2"},
    {"topic": "/cloud",                  "type": "sensor_msgs/PointCloud2"},
    {"topic": "/camera/image_raw",       "type": "sensor_msgs/Image"},
    {"topic": "/out/compressed",         "type": "sensor_msgs/CompressedImage"},
    {"topic": "/imu/data",               "type": "sensor_msgs/Imu"},
    {"topic": "/navsatfix",              "type": "sensor_msgs/NavSatFix"},
    {"topic": "/ekf/odometry_earth",     "type": "nav_msgs/Odometry"},
    {"topic": "/heading",                "type": "std_msgs/Float64"},
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
        rospy.loginfo_throttle(5.0, f"-> {mqtt_topic}")

    return cb


def main():
    rospy.init_node("ros_to_mqtt_bridge")
    mqtt_client.connect(MQTT_HOST, MQTT_PORT, 60)
    mqtt_client.loop_start()

    topics = rospy.get_param("~topics", DEFAULT_TOPICS)
    for entry in topics:
        try:
            cls = load_msg_class(entry["type"])
        except (ImportError, AttributeError) as exc:
            rospy.logwarn(f"skip {entry['topic']} ({entry['type']}): {exc}")
            continue
        rospy.Subscriber(entry["topic"], cls, make_callback(entry["topic"], entry["type"]))
        rospy.loginfo(f"subscribed {entry['topic']} ({entry['type']})")

    rospy.loginfo(f"bridge active on mqtt://{MQTT_HOST}:{MQTT_PORT}/{TOPIC_ROOT}/raw/#")
    rospy.spin()
    mqtt_client.loop_stop()
    mqtt_client.disconnect()


if __name__ == "__main__":
    main()
