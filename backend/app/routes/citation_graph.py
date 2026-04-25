from fastapi import APIRouter
import requests
import os
import fitz  # PyMuPDF

router = APIRouter()

UPLOAD_DIR = "uploaded_papers"


@router.get("/citation-graph")
def get_citation_graph(session_id: str):

    # 🔹 Get latest file (you can later replace with session-based)
    files = os.listdir(UPLOAD_DIR)
    pdf_files = [f for f in files if f.endswith(".pdf")]

    if not pdf_files:
        return {"nodes": [], "links": []}

    latest_file = max(
        pdf_files,
        key=lambda f: os.path.getctime(os.path.join(UPLOAD_DIR, f))
    )

    file_path = os.path.join(UPLOAD_DIR, latest_file)

    # 🔹 Extract title
    doc = fitz.open(file_path)
    text = doc[0].get_text()
    title = text.split("\n")[0][:200]

    # 🔹 Search OpenAlex
    search_url = f"https://api.openalex.org/works?search={title}&per_page=1"
    res = requests.get(search_url).json()

    if not res.get("results"):
        return {"nodes": [], "links": []}

    paper = res["results"][0]
    main_id = paper["id"]

    nodes = []
    edges = []
    node_ids = set()  # 🔥 prevent duplicates

    # 🔹 Main node
    nodes.append({
        "id": main_id,
        "label": paper["title"],
        "url": paper["id"],
        "year": paper.get("publication_year", 0),
        "size": 18
    })
    node_ids.add(main_id)

    # 🔹 References
    for ref in paper.get("referenced_works", [])[:15]:  # 🔥 reduced
        try:
            ref_id = ref.split("/")[-1]
            ref_api_url = f"https://api.openalex.org/works/{ref_id}"

            ref_res = requests.get(ref_api_url)
            if ref_res.status_code != 200:
                continue

            ref_data = ref_res.json()

            if ref_data["id"] in node_ids:
                continue

            citation_count = ref_data.get("cited_by_count", 0)

            nodes.append({
                "id": ref_data["id"],
                "label": ref_data["title"],
                "url": ref_data["id"],
                "year": ref_data.get("publication_year", 0),
                "size": max(4, min(20, citation_count / 50))
            })
            node_ids.add(ref_data["id"])

            edges.append({
                "source": main_id,
                "target": ref_data["id"],
                "weight": citation_count
            })

        except Exception as e:
            print("Error fetching reference:", e)
            continue

    # 🔹 SECONDARY REFERENCES (controlled)
    for node in nodes[:5]:  # 🔥 limit
        try:
            ref_id = node["id"].split("/")[-1]
            url = f"https://api.openalex.org/works/{ref_id}"

            res = requests.get(url)
            if res.status_code != 200:
                continue

            data = res.json()

            for ref in data.get("referenced_works", [])[:3]:
                try:
                    ref_id2 = ref.split("/")[-1]
                    url2 = f"https://api.openalex.org/works/{ref_id2}"

                    res2 = requests.get(url2)
                    if res2.status_code != 200:
                        continue

                    ref_data2 = res2.json()

                    if ref_data2["id"] in node_ids:
                        continue

                    nodes.append({
                        "id": ref_data2["id"],
                        "label": ref_data2["title"],
                        "url": ref_data2["id"],
                        "year": ref_data2.get("publication_year", 0),
                        "size": 5
                    })
                    node_ids.add(ref_data2["id"])

                    edges.append({
                        "source": node["id"],
                        "target": ref_data2["id"],
                        "weight": 1
                    })

                except:
                    continue

        except:
            continue

    return {"nodes": nodes, "links": edges}