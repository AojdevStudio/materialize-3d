const steps = [
  { title: "Describe", body: "Type what you want. Add a picture or link." },
  { title: "Make", body: "The agent works in the chat's own project folder and writes files there." },
  { title: "Look", body: "The right panel shows HTML pages, STL, 3MF and GLB models in an orbit viewer, and pictures." },
  { title: "Print", body: "Open the 3MF in Bambu Studio or the slicer of your choice. Check it. Print from there." },
] as const;

export function HowItWorks() {
  return (
    <section id="how" aria-labelledby="how-title">
      <h2 id="how-title" className="end-heading">
        How it works
      </h2>
      <ol className="how">
        {steps.map((step, i) => (
          <li key={step.title}>
            <span className="how-number">{String(i + 1).padStart(2, "0")}</span>
            <h3>{step.title}</h3>
            <p>{step.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
