from fastapi import APIRouter
import requests
import os
from difflib import SequenceMatcher
router = APIRouter()

UPLOAD_DIR = "uploaded_papers"

def score_match(query, candidate):
    return SequenceMatcher(None, query.lower(), candidate.lower()).ratio()

@router.get("/citation-graph")
def get_citation_graph(session_id: str):

    files = os.listdir(UPLOAD_DIR)
    pdf_files = [f for f in files if f.endswith(".pdf")]

    if not pdf_files:
        return {"nodes": [], "links": []}

    latest_file = max(
        pdf_files,
        key=lambda f: os.path.getctime(os.path.join(UPLOAD_DIR, f))
    )

    file_path = os.path.join(UPLOAD_DIR, latest_file)

    # 🔹 Extract title (IMPROVED)
    import fitz

    doc = fitz.open(file_path)
    text = doc[0].get_text()

    lines = [l.strip() for l in text.split("\n") if l.strip()]

    title = None

    # Try to detect actual research title
    for line in lines[:10]:
        if (
            ":" in line
            or line.isupper()
            or "framework" in line.lower()
            or "model" in line.lower()
        ):
            title = line
            break

    # fallback
    if not title:
        title = max(lines[:5], key=len)

    # final safety
    if len(title) < 10:
        title = "machine learning"

    # 🔹 Call OpenAlex
    search_url = f"https://api.openalex.org/works?search={title}&per_page=10"
    

    try:
        res = requests.get(search_url).json()
    except:
        return {"nodes": [], "links": []}

    if not res.get("results"):
        return {
            "nodes": [{"id": "no-data", "label": "No citation data found"}],
            "links": []
        }

    results = res.get("results", [])

    if not results:
        return {
            "nodes": [{"id": "no-data", "label": "No citation data found"}],
            "links": []
        }

    # ✅ pick BEST match
    paper = max(
        results,
        key=lambda r: score_match(title, r.get("title", ""))
    )
    main_id = paper["id"]

    nodes = []
    links = []

    # 🔹 Main paper
    nodes.append({
    "id": main_id,
    "label": paper["title"],
    "url": paper["id"],
    "year": paper.get("publication_year", 0),
    "size": 22,
    "type": "main"
})

    # 🔹 LIMIT references (IMPORTANT)
    refs = paper.get("referenced_works", [])[:8]

    for ref in refs:
        try:
            ref_id = ref.split("/")[-1]
            ref_api_url = f"https://api.openalex.org/works/{ref_id}"

            ref_res = requests.get(ref_api_url)

            if ref_res.status_code != 200:
                continue

            ref_data = ref_res.json()
            citation_count = ref_data.get("cited_by_count", 0)

            nodes.append({
            "id": ref_data["id"],
            "label": ref_data["title"],
            "url": ref_data["id"],
            "year": ref_data.get("publication_year", 0),
            "size": 8,
            "type": "reference"
            })

            links.append({
                "source": main_id,
                "target": ref_data["id"],
                "weight": citation_count or 1
            })

        except Exception as e:
            print("Error fetching reference:", e)
            continue

    # 🔹 REMOVE dense O(n^2) edges explosion
    # (kept simple for demo stability)

    # 🔹 OPTIONAL: very limited secondary refs (safe)
    extra_nodes = nodes.copy()

    for node in extra_nodes[:3]:  # 🔥 VERY SMALL LIMIT
        try:
            ref_id = node["id"].split("/")[-1]
            url = f"https://api.openalex.org/works/{ref_id}"

            res = requests.get(url)
            if res.status_code != 200:
                continue

            data = res.json()

            for ref in data.get("referenced_works", [])[:2]:
                try:
                    ref_id2 = ref.split("/")[-1]
                    url2 = f"https://api.openalex.org/works/{ref_id2}"

                    res2 = requests.get(url2)
                    if res2.status_code != 200:
                        continue

                    ref_data2 = res2.json()

                    # avoid duplicates
                    if any(n["id"] == ref_data2["id"] for n in nodes):
                        continue

                    nodes.append({
                    "id": ref_data2["id"],
                    "label": ref_data2["title"],
                    "url": ref_data2["id"],
                    "year": ref_data2.get("publication_year", 0),
                    "size": 5,
                    "type": "secondary"
                    })

                    links.append({
                        "source": node["id"],
                        "target": ref_data2["id"],
                        "weight": 1
                    })

                except:
                    continue

        except:
            continue

    # 🔹 FINAL fallback (never empty)
    if len(nodes) <= 1:
        return {
            "nodes": [{"id": "fallback", "label": "No meaningful citations"}],
            "links": []
        }

    return {"nodes": nodes, "links": links}