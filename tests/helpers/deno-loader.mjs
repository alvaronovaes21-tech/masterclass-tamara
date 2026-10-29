// Permite importar a Edge Function REAL (Deno) no Node para testes: mapeia o especificador "npm:" do Deno
// para os pacotes instalados em tests/node_modules.
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('npm:')) {
    const bare = specifier.slice(4).replace(/@[\d^~.x*]+$/, '');
    return next(bare, { ...context, parentURL: import.meta.url });
  }
  return next(specifier, context);
}
