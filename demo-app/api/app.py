import time
import random
import pyroscope
from flask import Flask, jsonify

pyroscope.configure(
    application_name="demo-api",
    server_address="http://pyroscope.observability.svc.cluster.local:4040",
)

app = Flask(__name__)

@app.route("/work")
def work():
    with pyroscope.tag_wrapper({"endpoint": "work"}):
        duration = random.uniform(0.05, 0.4)
        time.sleep(duration)

        if random.random() < 0.1:
            return jsonify({"error": "something went wrong"}), 500

        return jsonify({"status": "ok", "duration_ms": round(duration * 1000)})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8081)
