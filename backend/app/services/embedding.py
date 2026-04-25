import requests
import os
import numpy as np

JINA_API_URL = "https://api.jina.ai/v1/embeddings"
JINA_API_KEY = os.getenv("JINA_API_KEY")

print("JINA KEY LOADED:", os.getenv("JINA_API_KEY"))
def get_embeddings(chunks):
    response = requests.post(
        JINA_API_URL,
        headers={
            "Authorization": f"Bearer {JINA_API_KEY}",
            "Content-Type": "application/json"
        },
        json={
            "input": chunks,
            "model": "jina-embeddings-v2-base-en"
        }
    )

    print("STATUS:", response.status_code)
    print("RAW RESPONSE:", response.text[:200])

    if response.status_code != 200:
        raise Exception(f"Jina API Error: {response.text}")

    result = response.json()
    embeddings = [item["embedding"] for item in result["data"]]
    return np.array(embeddings)


def create_vector_store(chunks):
    chunks = chunks[:60]  # limit to avoid rate limits
    embeddings = get_embeddings(chunks)
    return chunks, embeddings  # ✅ return both so upload.py can unpack correctly