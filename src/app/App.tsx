import { AppRouter } from "./router";
import { AppProviders } from "./providers";

export default function App() {
  return (
    <AppProviders>
      <AppRouter />
    </AppProviders>
  );
}
