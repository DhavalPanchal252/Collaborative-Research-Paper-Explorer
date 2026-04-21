from fastapi import APIRouter
import requests
import os

router = APIRouter()

UPLOAD_DIR = "uploaded_papers"

@router.get("/citation-graph")
def get_citation_graph(session_id: str):
    # 🔹 Find latest uploaded PDF (simple approach)
    files = os.listdir(UPLOAD_DIR)
    pdf_files = [f for f in files if f.endswith(".pdf")]

    if not pdf_files:
        return {"nodes": [], "edges": []}

    latest_file = max(
        pdf_files,
        key=lambda f: os.path.getctime(os.path.join(UPLOAD_DIR, f))
    )

    file_path = os.path.join(UPLOAD_DIR, latest_file)

    # 🔹 Extract title (simple heuristic)
    import fitz  # PyMuPDF

    doc = fitz.open(file_path)
    text = doc[0].get_text()

    title = text.split("\n")[0][:200]

    # 🔹 Call OpenAlex
    search_url = f"https://api.openalex.org/works?search={title}&per_page=1"
    res = requests.get(search_url).json()

    if not res.get("results"):
        return {"nodes": [], "edges": []}

    paper = res["results"][0]
    main_id = paper["id"]

    nodes = []
    edges = []

    # 🔹 Main paper
    nodes.append({
    "id": main_id,
    "label": paper["title"],
    "url": paper["id"],
    "year": paper.get("publication_year", 0),
    "size": 18   # 🔥 main paper bigger
    })

    # 🔹 References
    for ref in paper.get("referenced_works", [])[:30]:
        try:
            # 🔹 Extract ID (W123...)
            ref_id = ref.split("/")[-1]

            # 🔹 Correct API endpoint
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

                # 🔥 IMPORTANT (size based on importance)
                "size": max(4, min(20, citation_count / 50))
            })

            edges.append({
            "source": main_id,
            "target": ref_data["id"],
            "weight": ref_data.get("cited_by_count", 1)
            })

        except Exception as e:
            print("Error fetching reference:", e)
            continue
        for i in range(len(nodes)):
            for j in range(i + 1, len(nodes)):
                edges.append({
                    "source": nodes[i]["id"],
                    "target": nodes[j]["id"],
                    "weight": 1
                })
        # ADD SECONDARY REFERENCES (creates network instead of star)
    extra_nodes = nodes.copy()

    for node in extra_nodes[:10]:  # limit to avoid too many API calls
        try:
            ref_id = node["id"].split("/")[-1]
            url = f"https://api.openalex.org/works/{ref_id}"

            res = requests.get(url)
            if res.status_code != 200:
                continue

            data = res.json()

            for ref in data.get("referenced_works", [])[:5]:
                try:
                    ref_id2 = ref.split("/")[-1]
                    url2 = f"https://api.openalex.org/works/{ref_id2}"

                    res2 = requests.get(url2)
                    if res2.status_code != 200:
                        continue

                    ref_data2 = res2.json()

                    nodes.append({
                        "id": ref_data2["id"],
                        "label": ref_data2["title"],
                        "url": ref_data2["id"],
                        "year": ref_data2.get("publication_year", 0),
                        "size": 5
                    })

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