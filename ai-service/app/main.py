from fastapi import FastAPI

app = FastAPI(title="Protea AI Service")

@app.get("/")
async def root():
    return {"message": "Protea AI Service is running"}

@app.get("/health")
async def health():
    return {"status": "healthy"}
