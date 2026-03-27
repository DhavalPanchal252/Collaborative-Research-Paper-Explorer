from app.services.llm.factory import get_llm

def generate_answer(question, context, model="groq"):
    llm = get_llm(model)
    return llm(question, context)