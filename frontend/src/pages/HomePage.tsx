import { Link } from 'react-router-dom'

type Props = {
  accountLabel: string
}

const actions = [
  {
    title: 'Universos',
    description: 'Crie cenários, lore e imagens-base para sustentar novas campanhas.',
    to: '/worlds',
    action: 'Abrir universos'
  },
  {
    title: 'Campanhas',
    description: 'Organize a temática de cada aventura e conecte o mundo certo ao seu arco.',
    to: '/campaigns',
    action: 'Ver campanhas'
  },
  {
    title: 'Personagens',
    description: 'Monte a ficha, revise vantagens e entre direto na sessão ativa.',
    to: '/characters',
    action: 'Gerenciar personagens'
  },
  {
    title: 'Regras',
    description: 'Consulte Savage Worlds e os atalhos da sua implementação antes de jogar.',
    to: '/rules',
    action: 'Consultar regras'
  }
]

export function HomePage({ accountLabel }: Props) {
  return (
    <section className="page-home">
      <div className="panel home-hero">
        <div className="home-hero-copy">
          <span className="home-eyebrow">Painel do mestre e dos jogadores</span>
          <h2>O RPG Adaptável agora abre apenas com sessão autenticada.</h2>
          <p>
            Sua conta ativa é <strong>{accountLabel}</strong>. A partir daqui, o fluxo recomendado é montar o universo,
            definir a campanha, revisar os personagens e então abrir a mesa em tempo real.
          </p>

          <div className="home-hero-actions">
            <Link className="home-primary-link" to="/worlds">
              Criar ou revisar universos
            </Link>
            <Link className="home-secondary-link" to="/characters">
              Entrar pelos personagens
            </Link>
          </div>
        </div>

        <div className="home-hero-side">
          <div className="home-stat-card">
            <span className="home-stat-label">Ritmo sugerido</span>
            <strong>1. Universo</strong>
            <strong>2. Campanha</strong>
            <strong>3. Personagem</strong>
            <strong>4. Sessão</strong>
          </div>
          <div className="home-stat-card home-stat-card--accent">
            <span className="home-stat-label">Acesso protegido</span>
            <p>As páginas da aplicação ficam fechadas até o login. Isso protege dados, ownership e sessões em andamento.</p>
          </div>
        </div>
      </div>

      <div className="home-card-grid">
        {actions.map((item) => (
          <Link key={item.to} className="home-card-link" to={item.to}>
            <article className="home-card">
              <h3>{item.title}</h3>
              <p>{item.description}</p>
              <span>{item.action}</span>
            </article>
          </Link>
        ))}
      </div>

      <div className="panel home-flow-panel">
        <div>
          <span className="home-eyebrow">Fluxo recomendado</span>
          <h3>Como iniciar uma mesa nova sem se perder</h3>
        </div>

        <div className="home-flow-grid">
          <div className="home-flow-step">
            <strong>01</strong>
            <p>Crie um universo com imagem e lore para definir o cenário base.</p>
          </div>
          <div className="home-flow-step">
            <strong>02</strong>
            <p>Abra uma campanha dentro desse universo e refine a temática com o texto gerado.</p>
          </div>
          <div className="home-flow-step">
            <strong>03</strong>
            <p>Monte os personagens vinculados à campanha e ajuste atributos, perícias e complicações.</p>
          </div>
          <div className="home-flow-step">
            <strong>04</strong>
            <p>Inicie a sessão e interaja pelo chat com o estado persistido por turno.</p>
          </div>
        </div>
      </div>
    </section>
  )
}
