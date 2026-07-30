import time
import random
import logging
import json
import pyroscope
from flask import Flask, jsonify
from opentelemetry import trace

pyroscope.configure(
    application_name="demo-api",
    server_address="http://pyroscope.observability.svc.cluster.local:4040",
)

app = Flask(__name__)

class JSONFormatter(logging.Formatter):
    def format(self, record):
        span = trace.get_current_span()
        ctx = span.get_span_context()
        trace_id = format(ctx.trace_id, "032x") if ctx.is_valid else None
        log_entry = {
            "timestamp": self.formatTime(record),
            "level": record.levelname,
            "message": record.getMessage(),
            "trace_id": trace_id,
        }
        return json.dumps(log_entry)

logger = logging.getLogger("demo-api")
handler = logging.StreamHandler()
handler.setFormatter(JSONFormatter())
logger.addHandler(handler)
logger.setLevel(logging.INFO)
logging.getLogger("werkzeug").disabled = True

@app.route("/work")
def work():
    with pyroscope.tag_wrapper({"endpoint": "work"}):
        duration = random.uniform(0.05, 0.4)
        time.sleep(duration)

        if random.random() < 0.1:
            logger.info(f"request failed after {round(duration*1000)}ms")
            return jsonify({"error": "something went wrong"}), 500

        logger.info(f"request succeeded after {round(duration*1000)}ms")
        return jsonify({"status": "ok", "duration_ms": round(duration * 1000)})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8081)
