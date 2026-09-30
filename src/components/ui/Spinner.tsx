export function Spinner({ label = "Loading" }: { label?: string }) {
  return <div className="spinner" role="progressbar" aria-label={label} />;
}

export default Spinner;
