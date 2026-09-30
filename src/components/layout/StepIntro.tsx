/** Eyebrow + title + copy block shared by the two setup steps. */
export function StepIntro({ step, title, copy }: { step: string; title: string; copy: string }) {
  return (
    <div className="step-intro">
      <div className="eyebrow">{step}</div>
      <h1 className="page-title">{title}</h1>
      <p className="page-copy">{copy}</p>
    </div>
  );
}

export default StepIntro;
