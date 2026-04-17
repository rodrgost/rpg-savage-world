import {
  ATTRIBUTES,
  SKILLS,
  EDGES,
  HINDRANCES,
  WEAPONS,
  ARMORS,
  RANKS,
  CORE_RULES,
  CHARACTER_CREATION,
} from '../data/savage-worlds'

const ATTR_LABEL: Record<string, string> = {
  agility: 'Agilidade',
  smarts: 'Astúcia',
  spirit: 'Espírito',
  strength: 'Força',
  vigor: 'Vigor',
}

/* ── helpers ── */

function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
  const result: Record<string, T[]> = {}
  for (const item of items) {
    const k = key(item)
    ;(result[k] ??= []).push(item)
  }
  return result
}

/* ── component ── */

export function RulesPage() {
  const skillsByAttr = groupBy(SKILLS, (s) => s.linkedAttribute)
  const edgesByCat = groupBy(EDGES, (e) => e.category)
  const meleeWeapons = WEAPONS.filter((w) => !w.isRanged)
  const rangedWeapons = WEAPONS.filter((w) => w.isRanged)

  return (
    <section className="panel page-rules">
      <h2 className="page-rules-title">📜 Regras do Jogo</h2>
      <p className="page-rules-subtitle">
        Consulte abaixo as mecânicas, atributos, perícias, vantagens, complicações, equipamentos e regras de progressão.
      </p>

      {/* ── Regras Básicas ── */}
      <details className="rules-section" open>
        <summary>Regras Básicas</summary>
        <div className="rules-section-body">
          {CORE_RULES.map((rule) => (
            <div key={rule.title} className="rules-rule-block">
              <h4>{rule.title}</h4>
              <p>{rule.text}</p>
            </div>
          ))}
        </div>
      </details>

      {/* ── Atributos ── */}
      <details className="rules-section">
        <summary>Atributos ({ATTRIBUTES.length})</summary>
        <div className="rules-section-body">
          <div className="rules-attr-grid">
            {ATTRIBUTES.map((a) => (
              <div key={a.key} className="rules-attr-card">
                <strong>{a.label}</strong>
                <span>{a.description}</span>
              </div>
            ))}
          </div>
        </div>
      </details>

      {/* ── Perícias ── */}
      <details className="rules-section">
        <summary>Perícias ({SKILLS.length})</summary>
        <div className="rules-section-body">
          {Object.entries(skillsByAttr).map(([attrKey, skills]) => (
            <div key={attrKey} className="rules-skill-group">
              <h4 className="rules-skill-group-title">{ATTR_LABEL[attrKey] ?? attrKey}</h4>
              <div className="rules-skill-list">
                {skills.map((s) => (
                  <div key={s.key} className="rules-skill-item">
                    <span className="rules-skill-name">{s.label}</span>
                    <span className="rules-skill-desc">{s.description}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </details>

      {/* ── Vantagens (Edges) ── */}
      <details className="rules-section">
        <summary>Vantagens ({EDGES.length})</summary>
        <div className="rules-section-body">
          {Object.entries(edgesByCat).map(([cat, edges]) => (
            <div key={cat} className="rules-edge-group">
              <h4 className="rules-edge-group-title">{cat}</h4>
              {edges.map((e) => (
                <div key={e.key} className="rules-edge-item">
                  <div className="rules-edge-header">
                    <strong>{e.label}</strong>
                    {e.requirementLabel && (
                      <span className="rules-edge-req">Req: {e.requirementLabel}</span>
                    )}
                  </div>
                  <p className="rules-edge-desc">{e.description}</p>
                </div>
              ))}
            </div>
          ))}
        </div>
      </details>

      {/* ── Complicações (Hindrances) ── */}
      <details className="rules-section">
        <summary>Complicações ({HINDRANCES.length})</summary>
        <div className="rules-section-body">
          <div className="rules-hindrance-list">
            {HINDRANCES.map((h) => (
              <div key={h.key} className="rules-hindrance-item">
                <div className="rules-hindrance-header">
                  <strong>{h.label}</strong>
                  <span className={`rules-severity-badge ${h.severity === 'major' ? 'rules-severity--major' : 'rules-severity--minor'}`}>
                    {h.severity === 'major' ? 'Maior' : 'Menor'}
                  </span>
                </div>
                <p className="rules-hindrance-desc">{h.description}</p>
              </div>
            ))}
          </div>
        </div>
      </details>

      {/* ── Armas ── */}
      <details className="rules-section">
        <summary>Armas ({WEAPONS.length})</summary>
        <div className="rules-section-body">
          <h4>Corpo a Corpo</h4>
          <div className="rules-table-wrap">
            <table className="rules-table">
              <thead>
                <tr>
                  <th>Arma</th>
                  <th>Dano</th>
                  <th>For Min.</th>
                  <th>Notas</th>
                </tr>
              </thead>
              <tbody>
                {meleeWeapons.map((w) => (
                  <tr key={w.key}>
                    <td>{w.label}</td>
                    <td>{w.damage}</td>
                    <td>{w.minStrength ? `d${w.minStrength}` : '—'}</td>
                    <td>{w.notes ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h4 style={{ marginTop: '1.5rem' }}>Distância</h4>
          <div className="rules-table-wrap">
            <table className="rules-table">
              <thead>
                <tr>
                  <th>Arma</th>
                  <th>Dano</th>
                  <th>Alcance</th>
                  <th>AP</th>
                  <th>For Min.</th>
                  <th>Notas</th>
                </tr>
              </thead>
              <tbody>
                {rangedWeapons.map((w) => (
                  <tr key={w.key}>
                    <td>{w.label}</td>
                    <td>{w.damage}</td>
                    <td>{w.range ?? '—'}</td>
                    <td>{w.ap ?? '—'}</td>
                    <td>{w.minStrength ? `d${w.minStrength}` : '—'}</td>
                    <td>{w.notes ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </details>

      {/* ── Armaduras ── */}
      <details className="rules-section">
        <summary>Armaduras ({ARMORS.length})</summary>
        <div className="rules-section-body">
          <div className="rules-table-wrap">
            <table className="rules-table">
              <thead>
                <tr>
                  <th>Armadura</th>
                  <th>Valor</th>
                  <th>For Min.</th>
                  <th>Notas</th>
                </tr>
              </thead>
              <tbody>
                {ARMORS.map((a) => (
                  <tr key={a.key}>
                    <td>{a.label}</td>
                    <td>+{a.armorValue}</td>
                    <td>{a.minStrength ? `d${a.minStrength}` : '—'}</td>
                    <td>{a.notes ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </details>

      {/* ── Ranks de Progressão ── */}
      <details className="rules-section">
        <summary>Ranks de Progressão ({RANKS.length})</summary>
        <div className="rules-section-body">
          <div className="rules-rank-list">
            {RANKS.map((r, i) => (
              <div key={r.key} className="rules-rank-item">
                <span className="rules-rank-number">{i + 1}</span>
                <div>
                  <strong>{r.label}</strong>
                  <span className="rules-rank-advances">
                    {r.advancesNeeded === 0 ? 'Início' : `${r.advancesNeeded}+ avanços`}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </details>

      {/* ── Criação de Personagem ── */}
      <details className="rules-section">
        <summary>Criação de Personagem</summary>
        <div className="rules-section-body">
          <div className="rules-creation-grid">
            <div className="rules-creation-item">
              <span className="rules-creation-value">{CHARACTER_CREATION.attributePoints}</span>
              <span className="rules-creation-label">Pontos de Atributo</span>
            </div>
            <div className="rules-creation-item">
              <span className="rules-creation-value">{CHARACTER_CREATION.skillPoints}</span>
              <span className="rules-creation-label">Pontos de Perícia</span>
            </div>
            <div className="rules-creation-item">
              <span className="rules-creation-value">d{CHARACTER_CREATION.startingDie}</span>
              <span className="rules-creation-label">Dado Inicial</span>
            </div>
            <div className="rules-creation-item">
              <span className="rules-creation-value">{CHARACTER_CREATION.maxMajorHindrances}</span>
              <span className="rules-creation-label">Máx. Complicações Maiores</span>
            </div>
            <div className="rules-creation-item">
              <span className="rules-creation-value">{CHARACTER_CREATION.maxMinorHindrances}</span>
              <span className="rules-creation-label">Máx. Complicações Menores</span>
            </div>
            <div className="rules-creation-item">
              <span className="rules-creation-value">{CHARACTER_CREATION.edgeCostInHindrancePoints} pts</span>
              <span className="rules-creation-label">Custo de uma Vantagem</span>
            </div>
          </div>
          <div className="rules-creation-note">
            <p>
              Cada personagem começa com todos os atributos em d4 e distribui{' '}
              <strong>{CHARACTER_CREATION.attributePoints} pontos</strong> para melhorá-los (cada ponto sobe um step: d4→d6→d8→d10→d12).
            </p>
            <p>
              Perícias começam em d0 e recebem <strong>{CHARACTER_CREATION.skillPoints} pontos</strong>.
              Subir acima do atributo vinculado custa 2 pontos por step, em vez de 1.
            </p>
            <p>
              Complicações concedem pontos extras: Menor = 1 pt, Maior = 2 pts (máximo 4 pts).
              Esses pontos podem ser gastos em Vantagens extras, pontos de atributo ou pontos de perícia.
            </p>
          </div>
        </div>
      </details>
    </section>
  )
}
