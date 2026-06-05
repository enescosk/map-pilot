#!/usr/bin/env python3
"""Reverse bridge: MQTT -> ROS.

Subscribes to map-pilot/control/+. For each incoming JSON envelope:
  {"topic": "/throttle_control", "type": "dbw_interface/...", "message": {...}}
populates a fresh ROS message and publishes it on the named topic. All
allowed publishers are advertised at startup so the first dashboard command
is not lost while subscribers discover the publisher.

Dashboard / external tools can drive the vehicle through this path without
talking to ROS directly.
"""
import importlib
import json
import os
import rospy
import paho.mqtt.client as mqtt
from rosbridge_library.internal.message_conversion import populate_instance

MQTT_HOST = os.environ.get("MQTT_HOST", "localhost")
MQTT_PORT = int(os.environ.get("MQTT_PORT", "1883"))
TOPIC_ROOT = os.environ.get("MQTT_TOPIC_ROOT", "map-pilot")
CONTROL_FILTER = f"{TOPIC_ROOT}/control/+"

# Whitelist: only these topic+type pairs are accepted. Keeps a malformed MQTT
# message from creating arbitrary ROS publishers.
ALLOWED = {
    "/throttle_control":         "dbw_interface/CruiseControlSignals",
    "/vcu_eps_control":          "dbw_interface/VCU_EPS_Control",
    "/vcu_ehb_control":          "dbw_interface/VCU_EHB_CONTROL",
    "/steer_control":            "beemobs_routine_manager/SteerControl",
    "/brake_control":            "beemobs_routine_manager/BrakeControl",
    "/autonomous_mode_selection": "beemobs_routine_manager/VehicleMode",
}

publishers = {}


def load_msg_class(type_str):
    pkg, msg = type_str.split("/")
    mod = importlib.import_module(f"{pkg}.msg")
    return getattr(mod, msg)


def prepare_publishers():
    # Advertise every allowed publisher up front so subscribers can latch on
    # before the first MQTT message arrives. Lazy creation loses the first
    # publish until peers discover the new advertisement.
    for topic, type_str in ALLOWED.items():
        try:
            cls = load_msg_class(type_str)
        except (ImportError, AttributeError) as exc:
            rospy.logwarn(f"skip {topic} ({type_str}): {exc}")
            continue
        publishers[topic] = rospy.Publisher(topic, cls, queue_size=10)
        rospy.loginfo(f"advertised {topic} ({type_str})")


def on_mqtt_message(client, userdata, msg):
    try:
        envelope = json.loads(msg.payload.decode("utf-8"))
    except json.JSONDecodeError as exc:
        rospy.logwarn(f"bad JSON on {msg.topic}: {exc}")
        return

    topic = envelope.get("topic")
    type_str = envelope.get("type") or ALLOWED.get(topic)
    payload = envelope.get("message") or {}

    if topic not in ALLOWED:
        rospy.logwarn_throttle(5.0, f"reject {topic}: not in whitelist")
        return
    if type_str != ALLOWED[topic]:
        rospy.logwarn_throttle(5.0, f"reject {topic}: type {type_str} != {ALLOWED[topic]}")
        return

    pub = publishers.get(topic)
    if pub is None:
        rospy.logwarn_throttle(5.0, f"no publisher for {topic} (failed to advertise at startup)")
        return

    try:
        instance = pub.data_class()
        populate_instance(payload, instance)
        pub.publish(instance)
        rospy.loginfo_throttle(2.0, f"<- {msg.topic} -> {topic}")
    except Exception as exc:
        rospy.logwarn(f"populate/publish failed for {topic}: {exc}")


def on_connect(client, userdata, flags, rc):
    rospy.loginfo(f"mqtt connected rc={rc}, subscribing {CONTROL_FILTER}")
    client.subscribe(CONTROL_FILTER)


def main():
    rospy.init_node("mqtt_to_ros_bridge")
    prepare_publishers()
    client = mqtt.Client()
    client.on_connect = on_connect
    client.on_message = on_mqtt_message
    client.connect(MQTT_HOST, MQTT_PORT, 60)
    client.loop_start()
    rospy.loginfo(f"reverse bridge active, allowed topics: {list(ALLOWED)}")
    rospy.spin()
    client.loop_stop()
    client.disconnect()


if __name__ == "__main__":
    main()
