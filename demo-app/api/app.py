import time
import random
from flask import Flask, jsonify

app = Flask(__name__)

@app.route("/work")
def work():
    # Simule un travail avec une durée variable
    duration = random.uniform(0.05, 0.4)
    time.sleep(duration)

    # Simule une erreur occasionnelle (10% du temps) - utile plus tard pour tester les alertes
    if random.random() < 0.1:
        return jsonify({"error": "something went wrong"}), 500

    return jsonify({"status": "ok", "duration_ms": round(duration * 1000)})

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8081)
