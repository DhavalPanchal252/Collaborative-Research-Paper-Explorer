import google.generativeai as genai

genai.configure(api_key="AIzaSyDUYAF_ui-tjUCMM7hwHE82Ra6s-D6z7h4")

for m in genai.list_models():
    print(m.name)