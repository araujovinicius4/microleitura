const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Verifica se o backend está funcionando
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    service: "microleitura-backend"
  });
});

// Gera um resumo do texto
app.post("/api/resumo", (req, res) => {
  const { texto } = req.body;

  if (!texto || typeof texto !== "string" || !texto.trim()) {
    return res.status(400).json({
      erro: "O campo 'texto' é obrigatório."
    });
  }

  // Temporário: depois será substituído pela chamada à IA
  const resumo = `Resumo de teste: ${texto.substring(0, 200)}`;

  res.json({
    resumo
  });
});

app.listen(PORT, "127.0.0.1", () => {
  console.log(
    `Microleitura Backend rodando em http://127.0.0.1:${PORT}`
  );
});