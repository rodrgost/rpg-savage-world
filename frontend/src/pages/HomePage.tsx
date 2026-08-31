import { Link } from 'react-router-dom'

type Props = {
  accountLabel: string
}

const actions = [
  {
    icon: '🌍',
    title: 'Universos',
    description: 'Crie cenários, guias canônicos e imagens-base para sustentar novas campanhas.',
    to: '/worlds',
    action: 'Abrir universos'
  },
  {
    icon: '⚔️',
    title: 'Campanhas',
    description: 'Organize a temática de cada aventura e conecte o mundo certo ao seu arco.',
    to: '/campaigns',
    action: 'Ver campanhas'
  },
  {
    icon: '🧙',
    title: 'Personagens',
    description: 'Monte a ficha, revise vantagens e entre direto na sessão ativa.',
    to: '/characters',
    action: 'Gerenciar personagens'
  },
  {
    icon: '🎲',
    title: 'Jogos ativos',
    description: 'Retome suas partidas em andamento de onde você parou.',
    to: '/active',
    action: 'Ver jogos ativos'
  },
  {
    icon: '📜',
    title: 'Regras',
    description: 'Consulte Savage Worlds e os atalhos da sua implementação antes de jogar.',
    to: '/rules',
    action: 'Consultar regras'
  }
]

const flowSteps = [
  { num: '01', icon: '🌍', label: 'Universo',    text: 'Crie um universo com imagem e guia canônico para definir o cenário base.' },
  { num: '02', icon: '⚔️', label: 'Campanha',    text: 'Abra uma campanha dentro desse universo e refine a temática.' },
  { num: '03', icon: '🧙', label: 'Personagem',  text: 'Monte a ficha vinculada à campanha e ajuste atributos e perícias.' },
  { num: '04', icon: '🎲', label: 'Sessão',       text: 'Inicie a sessão e interaja pelo chat com o estado persistido por turno.' },
]

export function HomePage({ accountLabel }: Props) {
  return (
    <section className="page-home">
      <div className="panel home-hero">
        <div className="home-hero-copy">
          <span className="home-eyebrow">🎲 Mesa Infinita · Savage Worlds</span>
          <h2>Monte sua mesa. Comece sua história.</h2>
          <p>
            Bem-vindo, <strong>{accountLabel}</strong>. Crie o universo, defina a campanha, monte seu personagem e abra
            a mesa — o narrador de IA cuida do resto.
          </p>

          <div className="home-hero-actions">
            <Link className="home-primary-link" to="/worlds">
              🌍 Criar ou revisar universos
            </Link>
            <Link className="home-secondary-link" to="/characters">
              🧙 Entrar pelos personagens
            </Link>
          </div>
        </div>

        <div className="home-hero-side">
          <div className="home-stat-card">
            <span className="home-stat-label">Fluxo recomendado</span>
            {flowSteps.map((s) => (
              <div key={s.num} className="home-stat-step">
                <span className="home-stat-step-num">{s.num}</span>
                <span className="home-stat-step-icon">{s.icon}</span>
                <strong>{s.label}</strong>
              </div>
            ))}
          </div>
          <div className="home-stat-card home-stat-card--accent">
            <span className="home-stat-label">🔐 Sessão autenticada</span>
            <p>Seus mundos, campanhas e personagens ficam protegidos. Cada sessão é persistida por turno.</p>
          </div>
        </div>
      </div>

      <div className="home-card-grid">
        {actions.map((item) => (
          <Link key={item.to} className="home-card-link" to={item.to}>
            <article className="home-card">
              <span className="home-card-icon">{item.icon}</span>
              <h3>{item.title}</h3>
              <p>{item.description}</p>
              <span className="home-card-action">{item.action} →</span>
            </article>
          </Link>
        ))}
      </div>

      <div className="panel home-flow-panel">
        <div>
          <span className="home-eyebrow">Passo a passo</span>
          <h3>Como iniciar uma mesa nova</h3>
        </div>

        <div className="home-flow-grid">
          {flowSteps.map((s, i) => (
            <div key={s.num} className="home-flow-step">
              <div className="home-flow-step-header">
                <span className="home-flow-num">{s.num}</span>
                {i < flowSteps.length - 1 && <span className="home-flow-connector" aria-hidden="true" />}
              </div>
              <span className="home-flow-icon">{s.icon}</span>
              <strong>{s.label}</strong>
              <p>{s.text}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}
