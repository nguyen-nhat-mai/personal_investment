# Pinned deliberately to Airflow 2.x: this project's DAGs use `airflow.datasets.Dataset` for
# data-aware scheduling, which was renamed to `Asset` in Airflow 3.0. Check
# https://hub.docker.com/r/apache/airflow/tags for the latest 2.10.x patch release when you
# build this - the tag below is current as of this project's authoring (Jan 2026 knowledge
# cutoff), not necessarily today.
FROM apache/airflow:2.10.5-python3.11

COPY requirements-airflow.txt /requirements-airflow.txt
RUN pip install --no-cache-dir -r /requirements-airflow.txt
