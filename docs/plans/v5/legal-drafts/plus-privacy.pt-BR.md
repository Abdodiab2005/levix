# Suplemento de Privacidade do Levix Plus

Este documento descreve as práticas de tratamento de dados para a assinatura opcional **Levix Plus** em compilações do Levix para Android.

---

## 1. Visão geral e finalidades

O Levix Plus é uma assinatura paga e opcional. O serviço de verificação operado pela Leviro em `https://levix-plus.leviro.net` coleta e processa metadados limitados de assinatura e instalação exclusivamente para as seguintes finalidades:
- Verificar compras e a validade da assinatura junto ao Google Play.
- Aplicar a política de instalação da assinatura (uma instalação ativa por vez, com até três transferências de instalação em qualquer período móvel de 30 dias).
- Prevenir fraudes e abusos.

O Levix Plus **não contém publicidade**, não realiza rastreamento entre aplicativos de terceiros e **não vende dados de usuários**.

---

## 2. Dados que saem do dispositivo

Quando você decide comprar, restaurar ou verificar o Levix Plus, ou quando o aplicativo atualiza automaticamente a autorização da assinatura, o aplicativo envia uma solicitação direta para `https://levix-plus.leviro.net`.

A solicitação contém:
- O token de compra do Google Play (purchase token).
- O nome do pacote Android e o identificador do produto.
- Um identificador pseudônimo de instalação (um hash SHA-256 de uma chave pública de instalação gerada no dispositivo).
- A própria chave pública da instalação (Ed25519).
- Um nonce de solicitação.
- O carimbo de data/hora (timestamp) do cliente.
- Um número sequencial monotônico da solicitação.
- Uma assinatura criptográfica Ed25519 gerada sobre o payload da solicitação utilizando a chave privada da instalação presente no dispositivo.

**O que nunca é enviado:** o Levix Plus nunca transmite mensagens do WhatsApp, conteúdo de conversas, identificadores de participantes, contatos ou números de telefone para o serviço de verificação.

---

## 3. Processamento pelo Google Play e notificações em tempo real

- O Google Play processa compras, renovações, cancelamentos e reembolsos da assinatura segundo os termos e as políticas de privacidade aplicáveis da Google.
- O serviço de verificação consulta a API de Desenvolvedor do Google Play (Developer API) para confirmar o status da compra da assinatura, datas de expiração e confirmação de recebimento (acknowledgement).
- O serviço de verificação recebe Notificações de Desenvolvedor em Tempo Real (RTDN) autenticadas do Google Play via Google Cloud Pub/Sub para responder a renovações, cancelamentos, períodos de carência e reembolsos de assinaturas.

---

## 4. Dados armazenados pelo serviço de verificação

O serviço de verificação armazena os seguintes registros:
- Um hash SHA-256 do token de compra e o próprio token de compra criptografado em repouso com AES-256-GCM usando uma chave de serviço.
- Metadados da assinatura: nome do pacote, identificador do produto, status da assinatura no Google Play, carimbo de data/hora de expiração, status de confirmação, indicador de compra de teste e carimbos de data/hora de vinculação inicial e verificações.
- Registros de vinculação da instalação: chave pública da instalação, contador de sequência e carimbos de data/hora de registro e atualização.
- Histórico de transferências de instalação: carimbos de data/hora e identificadores de instalação associados a transferências entre dispositivos.
- Identificadores de mensagens de notificação do Google Cloud Pub/Sub.

---

## 5. Períodos de retenção e proteções de registros (logs)

- **Nonces de solicitação:** Retidos por 10 minutos para evitar ataques de repetição, sendo excluídos automaticamente em seguida.
- **IDs de mensagem do Pub/Sub:** Retidos por 7 dias para evitar processamento duplicado de notificações do Google Play, sendo excluídos em seguida.
- **Compras e histórico de transferências:** Excluídos 90 dias após a expiração da assinatura no Google Play.
- **Registros de instalação:** Mantidos enquanto o serviço de verificação estiver em operação.
- **Backups do servidor:** Seguem o cronograma padrão de retenção de backups do operador do serviço.
- **Proteções de logs:** O serviço de verificação nunca grava em log tokens de compra, assinaturas de solicitação, chaves privadas ou corpos brutos de solicitação. Endereços IP são usados exclusivamente para controle transitório de taxa (rate limiting) em memória.

---

## 6. Dados armazenados localmente no dispositivo

- A chave privada da instalação e o token de autorização assinado digitalmente retornado pelo serviço de verificação são armazenados selados (criptografados com AES-256-GCM) no banco de dados local do Levix.
- A chave privada da instalação e o token de autorização assinado **nunca** são incluídos em exportações de configurações, cópias pré-migração do banco de dados ou backups exportados pelo usuário, e **nunca** são enviados para nenhum servidor (apenas a chave pública correspondente é enviada ao serviço de verificação).

---

## 7. Backups e restauração

- Backups locais criptografados do Levix (criados em Configurações > Backup com uma senha definida pelo operador) podem incluir personalizações do Plus: mensagens personalizadas do bot e suas traduções, predefinições, preferências de visibilidade e regras de Resposta Automática (incluindo configurações de memória global por conversa).
- Restaurar um backup **nunca** ativa o Levix Plus; o status da autorização é sempre verificado novamente junto ao serviço de verificação.
- As regras de Resposta Automática são restauradas apenas quando a mesma conta do WhatsApp for vinculada.

---

## 8. Recursos de Resposta Automática e IA

- Quando uma regra de Resposta Automática é acionada, o bot envia o texto da mensagem e o contexto da conversa ao provedor de IA configurado pelo operador, exatamente sob os mesmos termos, configurações e limites de privacidade do recurso gratuito de IA.
- A memória global de longo prazo é usada em uma conversa de Resposta Automática apenas se o operador ativar expressamente a memória global para aquela conversa específica; caso contrário, o acesso à memória permanece estritamente restrito àquela conversa individual.

---

## 9. Solicitações de exclusão de dados

- Você pode solicitar a exclusão dos registros do serviço de verificação vinculados à sua compra entrando em contato com o Suporte da Leviro em **Configurações > Feedback** no aplicativo.
- O Google Play mantém seus próprios registros financeiros de transações e histórico de compras de acordo com as políticas de retenção de dados da Google.
