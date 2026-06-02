// pnpm install hook.
//
// Strip node-llama-cpp's GPU prebuilt-binary packages (CUDA / Vulkan) from its
// optionalDependencies. The Librarian runs CPU-only embedding inference, and
// those optional packages pull ~650 MB of unused binaries (CUDA ~595 MB +
// Vulkan ~60 MB) into every install and the Docker image. The platform CPU
// binary (@node-llama-cpp/<os>-<arch>, ~21 MB on linux-x64) is kept, so
// embedding still works out of the box. Drop this hook if GPU inference is
// ever wanted.
function readPackage(pkg) {
  if (pkg.name === "node-llama-cpp" && pkg.optionalDependencies) {
    for (const dep of Object.keys(pkg.optionalDependencies)) {
      if (dep.includes("-cuda") || dep.includes("-vulkan")) {
        delete pkg.optionalDependencies[dep];
      }
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
