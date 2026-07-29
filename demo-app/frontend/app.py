import requests
from flask import Flask, jsonify

app = Flask(__name__)

API_URL = "http://demo-api.observability.svc.cluster.local:8081/work"

@app.route("/")
def index():
    try:
        response = requests.get(API_URL, timeout=5)
        return jsonify({
            "frontend_status": "ok",
            "api_response": response.json(),
            "api_status_code": response.status_code
        })
    except requests.exceptions.RequestException as e:
        return jsonify({"frontend_status": "error", "detail": str(e)}), 502

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8082)
