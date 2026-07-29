FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir setuptools==75.1.0 && \
    pip install --no-cache-dir -r requirements.txt && \
    opentelemetry-bootstrap -a install

COPY app.py .

EXPOSE 8082

CMD ["opentelemetry-instrument", "python", "app.py"]
