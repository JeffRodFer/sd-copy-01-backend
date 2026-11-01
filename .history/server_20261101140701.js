const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const app = express();

// Configuração de permissões do CORS
app.use(cors({
  origin: '*', // Permite acessos do seu frontend
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* =====================================================
   MIDDLEWARE: VERIFICAR TOKEN JWT
===================================================== */
function verificarToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Formato: "Bearer TOKEN"

  if (!token) {
    return res.status(401).json({ error: 'Acesso negado. Token não fornecido.' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Token inválido ou expirado.' });
    }

    req.user = user;
    next();
  });
}

/* =====================================================
   ROTA DE LOGIN DO ADMINISTRADOR
===================================================== */
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;

  // Verifica se o utilizador bate com o do .env
  if (username === process.env.ADMIN_USER) {

    // Compara a palavra-passe digitada com o hash armazenado no .env
    const senhaCorreta = await bcrypt.compare(password, process.env.ADMIN_PASSWORD_HASH);

    if (senhaCorreta) {
      // Gera o token se a palavra-passe estiver correta
      const token = jwt.sign(
        { username: username },
        process.env.JWT_SECRET,
        { expiresIn: '8h' }
      );

      return res.json({
        success: true,
        token: token,
        message: 'Login realizado com sucesso!'
      });
    }
  }

  return res.status(401).json({ error: 'Utilizador ou senha inválidos.' });
});


// GET /api/cardapio
app.get('/api/cardapio', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, nome, preco, categoria, disponivel, estoque FROM produtos ORDER BY id');
    res.json(result.rows);
  } catch (err) {
    console.error("Erro ao buscar cardápio:", err);
    res.status(500).json({ erro: "Erro interno ao carregar cardápio." });
  }
});



/* =========================================================
   ROTA DE LOGIN ADMINISTRATIVO (COM HASH)
   ========================================================= */
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    const usuarioCorreto = 'admin';
    // Substitua este valor pelo HASH real da sua palavra-passe!
    // (Abaixo está um exemplo de hash bcrypt para a senha '123456')
    const hashGuardado = '$2a$12$5UBJ1VqEirKW4WKWAU150.1Tqc5Iv8orHAeF5kHtWF4Sn3HLgT4.O';

    // Verifica se o utilizador está correto primeiro
    if (username !== usuarioCorreto) {
      return res.status(401).json({ error: 'Utilizador ou palavra-passe incorretos.' });
    }

    // Compara a palavra-passe que veio do frontend com o hash guardado
    const senhaValida = await bcrypt.compare(password, hashGuardado);

    if (senhaValida) {
      res.status(200).json({ success: true, message: 'Login aprovado!' });
    } else {
      res.status(401).json({ error: 'Utilizador ou palavra-passe incorretos.' });
    }
  } catch (error) {
    console.error('Erro na validação do login:', error);
    res.status(500).json({ error: 'Erro interno no servidor.' });
  }
});



// POST /api/admin/atualizar-lote (Protegido por JWT)
app.post('/api/admin/atualizar-lote', verificarToken, async (req, res) => {
  const { produtos } = req.body;
  if (!Array.isArray(produtos)) {
    return res.status(400).json({ erro: 'Formato inválido.' });
  }

  try {
    for (let p of produtos) {
      await pool.query(
        'UPDATE produtos SET preco = $1, estoque = $2, disponivel = $3 WHERE id = $4',
        [p.preco, p.estoque, p.disponivel, p.id]
      );
    }
    res.json({ sucesso: true, mensagem: 'Estoque e preços atualizados com sucesso!' });
  } catch (err) {
    console.error("Erro ao atualizar lote:", err);
    res.status(500).json({ erro: 'Erro ao atualizar dados no banco.' });
  }
});

// POST /api/registrar-venda
app.post('/api/registrar-venda', async (req, res) => {
  const { itensCarrinho } = req.body;

  if (!Array.isArray(itensCarrinho) || itensCarrinho.length === 0) {
    return res.status(400).json({ erro: 'Carrinho vazio ou inválido.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    for (let item of itensCarrinho) {
      const check = await client.query('SELECT estoque, nome FROM produtos WHERE id = $1', [item.id]);
      if (check.rows.length === 0) {
        throw new Error(`Produto ID ${item.id} não encontrado.`);
      }

      const produto = check.rows[0];
      if (produto.estoque < item.quantidade) {
        throw new Error(`Estoque insuficiente para o item: ${produto.nome}. Disponível: ${produto.estoque}`);
      }

      await client.query(
        'UPDATE produtos SET estoque = estoque - $1 WHERE id = $2',
        [item.quantidade, item.id]
      );
    }

    await client.query('COMMIT');
    res.json({ sucesso: true, mensagem: 'Venda registada e estoque atualizado com sucesso!' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error("Erro na venda:", err);
    res.status(400).json({ erro: err.message || 'Erro ao processar baixa no estoque.' });
  } finally {
    client.release();
  }
});

// POST /admin/estornar
app.post('/admin/estornar', async (req, res) => {
  const { itensEstorno } = req.body;

  if (!Array.isArray(itensEstorno) || itensEstorno.length === 0) {
    return res.status(400).json({ erro: 'Dados de estorno inválidos.' });
  }

  try {
    for (let item of itensEstorno) {
      await pool.query(
        'UPDATE produtos SET estoque = estoque + $1 WHERE id = $2',
        [item.quantidade, item.id]
      );
    }
    res.json({ sucesso: true, mensagem: 'Estorno realizado com sucesso.' });
  } catch (err) {
    console.error("Erro ao estornar:", err);
    res.status(500).json({ erro: 'Erro ao processar estorno.' });
  }
});

module.exports = app;