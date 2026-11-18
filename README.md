# Moto Peças

E-commerce demonstrativo de moto peças, com **API REST e site responsivo em português**. Os quatro fluxos são login, cadastro, carrinho e finalização de compra. O catálogo público apoia a escolha das peças. Pagamentos e entregas são simulados.

Feito com Node.js, Express, MongoDB temporário (`mongodb-memory-server`), HTML, CSS e JavaScript. O próprio Express serve o site e a API na mesma origem. Não precisa de MongoDB instalado, Docker, serviços pagos ou ferramentas de frontend.

## Como instalar

Requisitos: **Node.js 22.13 ou superior**, npm e acesso à internet na instalação e na primeira execução, para baixar o binário do MongoDB. Node.js 24 também é compatível.

```sh
git clone https://github.com/cmls-gama/moto-pecas.git
cd moto-pecas
npm ci
```

Enquanto o Pull Request estiver aberto, acesse a implementação com `git switch feat/moto-pecas-ecommerce` antes de executar `npm ci`.

O `package-lock.json` fixa as dependências. O MongoDB será baixado para `.cache/mongodb/` na primeira inicialização. Esse cache não é versionado e **não contém os dados da loja**. Se o download for bloqueado, verifique o acesso a `fastdl.mongodb.org`. Em Linux, o binário pode exigir as bibliotecas do sistema descritas na [documentação do mongodb-memory-server](https://typegoose.github.io/mongodb-memory-server/docs/guides/quick-start-guide/).

## Como executar

```sh
npm start
```

Aguarde a mensagem `Site: http://127.0.0.1:3000`. O primeiro início pode demorar por causa do download do MongoDB. `localhost:3000` também funciona quando não há outro servidor usando a interface IPv6 nessa porta; use a URL impressa no terminal para acessar esta aplicação diretamente. Se a porta estiver ocupada, configure outra em `.env`, por exemplo `PORT=3001`.

Para reiniciar automaticamente ao editar o código:

```sh
npm run dev
```

Encerre com **Ctrl+C**. Cada inicialização cria um banco novo e repõe os dados de demonstração. Contas criadas, carrinhos, pedidos e sessões são descartados ao encerrar o servidor. O banco roda como um replica set temporário de um nó com WiredTiger para suportar transações; seus arquivos temporários são removidos pelo `mongodb-memory-server` ao encerrar normalmente.

Configuração opcional: copie `.env.example` para `.env`. No PowerShell, use `Copy-Item .env.example .env`.

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `PORT` | `3000` | Porta HTTP |
| `HOST` | `127.0.0.1` | Interface de escuta local |
| `SESSION_SECRET` | Aleatório a cada início | Segredo de sessão, mínimo de 32 caracteres |
| `COOKIE_SECURE` | `false` | Use `true` somente se acessar via HTTPS |

## Dados de teste incluídos

São criados **exatamente três usuários e três produtos** na inicialização. Os três usuários usam a senha **`Moto@123`**.

| Cliente | E-mail | Acumulado em produtos | Condição inicial |
| --- | --- | --- | --- |
| Ana Silva | `ana@motopecas.com` | R$ 0,00 | Comum |
| Bruno Santos | `bruno@motopecas.com` | R$ 250,00 | Comum, faltam R$ 50,00 para VIP |
| Carla Oliveira | `carla@motopecas.com` | R$ 350,00 | VIP, frete grátis |

Bruno e Carla possuem um pedido histórico cada para justificar seus acumulados. Os preços históricos são diferentes dos atuais. O estoque abaixo já representa o saldo disponível após o histórico. Esses pedidos não são baixados novamente.

| ID do produto | Produto | Preço | Estoque inicial |
| --- | --- | --- | --- |
| `kit-relacao` | Kit de relação | R$ 189,90 | 8 |
| `disco-freio` | Disco de freio dianteiro | R$ 129,90 | 3 |
| `filtro-oleo` | Filtro de óleo | R$ 49,90 | 0 |

As descrições e ilustrações das peças são demonstrativas. O filtro sem estoque permite validar o bloqueio de adição pelo site e pela API. Novos clientes são cadastrados com acumulado zero e sem condição VIP.

## Regras de negócio

1. **Dinheiro:** desconto de 10% no subtotal dos produtos. O frete não recebe desconto. Arredondamento ao centavo mais próximo. Cartão não dá desconto. Ambas as formas são simuladas, sem coleta de dados de cartão.
2. **Estoque:** apenas produtos com estoque podem entrar no carrinho. A soma das unidades do mesmo produto não pode ultrapassar o estoque atual nem 99 unidades por item. Adicionar ao carrinho não reserva nem baixa estoque. A finalização revalida e baixa as unidades em uma transação.
3. **VIP:** cliente se torna VIP ao acumular **R$ 300,00 ou mais em produtos após descontos**, sem contar o frete. O benefício passa a valer **na compra seguinte** à que atingiu o limite. Não há expiração de VIP.
4. **Frete:** fixo de R$ 20,00 para clientes comuns e grátis para VIP em cada compra. Carrinho vazio exibe total e frete zero e não pode ser finalizado.
5. **Compra atômica:** estoque, pedido, acumulado e limpeza do carrinho são confirmados juntos. Em caso de falha, nenhuma dessas alterações é aplicada. Carrinhos pertencem à conta e permanecem entre logins enquanto a aplicação estiver rodando.
6. **Valores confiáveis:** o servidor calcula preço, desconto, frete, acumulado e condição VIP. Campos adicionais enviados no checkout são rejeitados.
7. **Repetição de compra:** o checkout exige `Idempotency-Key` com um UUID. A repetição da mesma chave pelo mesmo cliente devolve o pedido original sem baixar estoque ou aumentar o acumulado novamente. Uma nova compra deve usar outra chave.

Os critérios de acumulado líquido, frete fixo e início do benefício na compra seguinte são as convenções adotadas para tornar as regras fornecidas explícitas.

Exemplos com um disco de freio:

| Situação | Produtos | Desconto | Frete | Total |
| --- | --- | --- | --- | --- |
| Ana, dinheiro | R$ 129,90 | R$ 12,99 | R$ 20,00 | R$ 136,91 |
| Carla VIP, dinheiro | R$ 129,90 | R$ 12,99 | Grátis | R$ 116,91 |
| Ana, cartão | R$ 129,90 | R$ 0,00 | R$ 20,00 | R$ 149,90 |

Bruno, ao comprar um disco em dinheiro, passa de R$ 250,00 para **R$ 366,91 acumulados**. Essa compra ainda cobra R$ 20,00 de frete; a próxima terá frete grátis.

## URLs importantes

Com a porta padrão:

| URL | Uso |
| --- | --- |
| [http://localhost:3000](http://localhost:3000) | Site: catálogo, acesso à conta, carrinho e checkout |
| [http://localhost:3000/docs](http://localhost:3000/docs) | Swagger UI interativo, renderizado a partir do YAML |
| [http://localhost:3000/api-docs.yaml](http://localhost:3000/api-docs.yaml) | Especificação OpenAPI 3.0.3 em YAML |
| [http://localhost:3000/api/health](http://localhost:3000/api/health) | Disponibilidade da aplicação |
| [http://localhost:3000/api/products](http://localhost:3000/api/products) | Catálogo em JSON |

O arquivo da especificação é `openapi.yaml`, na raiz do projeto. O Swagger usa a API da mesma origem, inclusive quando a porta é alterada.

## API REST

| Método | Endpoint | Sessão necessária | Função |
| --- | --- | --- | --- |
| GET | `/api/health` | Não | Disponibilidade |
| GET | `/api/products` | Não | Listar produtos |
| POST | `/api/auth/register` | Não | Cadastrar e entrar |
| POST | `/api/auth/login` | Não | Entrar |
| GET | `/api/auth/me` | Sim | Consultar cliente e condição VIP |
| POST | `/api/auth/logout` | Não | Sair |
| GET | `/api/cart` | Sim | Ver carrinho e simulações |
| POST | `/api/cart/items` | Sim | Adicionar quantidade |
| PATCH | `/api/cart/items/{productId}` | Sim | Substituir quantidade |
| DELETE | `/api/cart/items/{productId}` | Sim | Remover item |
| POST | `/api/checkout` | Sim | Finalizar compra |
| GET | `/api/orders/{orderId}` | Sim | Recuperar confirmação de pedido próprio |

Todas as mutações exigem `Content-Type: application/json`, inclusive DELETE e logout. Os valores monetários em respostas são **inteiros em centavos**. A senha é armazenada como hash com sal usando `scrypt`. Sessões usam cookie HttpOnly/SameSite com validade de duas horas e armazenamento em memória. Login e cadastro compartilham limite de 50 tentativas por IP a cada 15 minutos. Requisições de alteração com `Origin` diferente da própria aplicação são bloqueadas. Não há autenticação por token no localStorage.

Use **Try it out** em `/docs`: faça login com um usuário de demonstração, adicione um produto e finalize. O navegador preserva o cookie automaticamente; use o mesmo hostname para o site e o Swagger.

Exemplo de corpo de checkout (gere um UUID para o cabeçalho `Idempotency-Key`):

```json
{
  "paymentMethod": "cash",
  "address": {
    "recipient": "Bruno Santos",
    "zipCode": "01001-000",
    "street": "Praça da Sé",
    "number": "100",
    "complement": "Apto 10",
    "city": "São Paulo",
    "state": "SP"
  }
}
```

Respostas de erro usam `{ "error": { "code": "...", "message": "...", "details": [] } }`; `details` aparece apenas nos erros de validação. Principais status: `400` dados inválidos/carrinho vazio, `401` acesso não autenticado, `403` origem bloqueada, `404` recurso não encontrado, `409` estoque/e-mail em conflito, `413` corpo maior que 16 KB, `415` conteúdo sem JSON e `429` limite de autenticação.

## Estrutura e validação

```text
src/
  server.js       HTTP, autenticação, validação e documentação
  database.js     MongoDB temporário, índices e dados iniciais
  security.js     Hash de senha e dados públicos do cliente
  shop.js         Carrinho, cálculo de totais e transação de compra
public/
  index.html      Interface em português
  styles.css      Layout responsivo
  app.js          Integração com a API
  images/         Ilustrações SVG locais
openapi.yaml      Contrato da API
```

**Não há automação de testes**, conforme solicitado. `npm run check` verifica apenas sintaxe dos arquivos JavaScript; não executa testes. Para validação manual:

1. Cadastre uma conta e confirme login, logout e bloqueio de e-mail duplicado.
2. Adicione uma peça, altere a quantidade, remova e tente adicionar o filtro sem estoque pela API.
3. Confira os totais em dinheiro e cartão com Ana e Carla.
4. Com Bruno, finalize um disco em dinheiro e confira a promoção VIP e o frete da compra seguinte.
5. Abra duas sessões com o último estoque disponível e confirme que só uma compra é aprovada.
6. Repita um checkout com a mesma chave e confirme que há apenas um pedido e uma baixa.
7. Reinicie a aplicação e confira a recriação dos três usuários e dos três produtos.

Referências técnicas: [Express](https://expressjs.com/en/5x/api/), [transações MongoDB](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/) e [OpenAPI/Swagger](https://swagger.io/docs/specification/v3_0/basic-structure/).
