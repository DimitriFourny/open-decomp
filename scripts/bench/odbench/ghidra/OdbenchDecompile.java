// odbench: post-script. Decompiles the functions of a list with Ghidra's program decompiler options
// (C code, syntax tree, simplification style "decompile", 300 s per function; the settings of the
// retired structure sample, `git show 0eaab0f:scripts/bench/ghidra-decompile-list.java`) and
// records how each function was located.
//
// Arguments: <list file> <out dir> <mark file>
//   list file: one `fnKey<TAB>va<TAB>name-or-empty` line per function (va = Open Decomp virtual address)
//   mark file: written by OdbenchMark.java (ms since epoch, after import and before analysis)
// Output in <out dir>: `<fnKey>.c` (the raw getC() text), `results.jsonl` (one JSON line per function:
// fnKey, state, method, name, address, ghidra_address, ms, error) and `meta.json`.
// `method`: name | underscore-name (unique global function; Mach-O symbols carry a leading `_`) |
// name-address-mismatch (name matched but the entry is not the expected address) | address |
// rebased-address (position-independent ELF that Ghidra moved) | created-at-address (Ghidra's
// analysis found no function at the corpus entry in executable memory, so it was created there).
// `address` is in Open Decomp's va space (equal to the corpus va when resolved correctly).
// The class name must equal the file name.
import ghidra.app.decompiler.DecompInterface;
import ghidra.app.decompiler.DecompileOptions;
import ghidra.app.decompiler.DecompileResults;
import ghidra.app.script.GhidraScript;
import ghidra.app.util.opinion.ElfLoader;
import ghidra.program.model.address.Address;
import ghidra.program.model.listing.Function;
import ghidra.program.model.mem.MemoryBlock;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardOpenOption;
import java.util.List;

public class OdbenchDecompile extends GhidraScript {
  private static final int DECOMPILE_TIMEOUT_SECONDS = 300;

  @Override
  public void run() throws Exception {
    long started = System.currentTimeMillis();
    String[] args = getScriptArgs();
    List<String> list = Files.readAllLines(Paths.get(args[0]));
    Path out = Paths.get(args[1]);
    long mark = Long.parseLong(Files.readString(Paths.get(args[2])).trim());
    Files.createDirectories(out);
    Path results = out.resolve("results.jsonl");
    Files.writeString(results, "");

    long imageBase = currentProgram.getImageBase().getOffset();
    Long original = ElfLoader.getElfOriginalImageBase(currentProgram);
    boolean elf = String.valueOf(currentProgram.getExecutableFormat()).contains("ELF");
    if (original == null && elf) original = Long.valueOf(0L);
    // Ghidra moves position-independent ELF images to 0x100000: the Open Decomp va then differs from the Ghidra address.
    boolean rebased = original != null && original.longValue() != imageBase;
    long originalBase = original == null ? imageBase : original.longValue();
    Files.writeString(
        out.resolve("meta.json"),
        "{\"analysis_ms\":" + (started - mark)
            + ",\"image_base\":\"0x" + Long.toHexString(imageBase)
            + "\",\"original_image_base\":" + (original == null ? "null" : "\"0x" + Long.toHexString(original.longValue()) + "\"")
            + ",\"rebased\":" + rebased
            + ",\"format\":" + quote(String.valueOf(currentProgram.getExecutableFormat()))
            + ",\"language\":" + quote(currentProgram.getLanguageID().toString()) + "}\n");

    DecompInterface ifc = new DecompInterface();
    DecompileOptions options = new DecompileOptions();
    options.grabFromProgram(currentProgram);
    ifc.setOptions(options);
    ifc.toggleCCode(true);
    ifc.toggleSyntaxTree(true);
    ifc.setSimplificationStyle("decompile");
    boolean opened = ifc.openProgram(currentProgram);
    String openError = opened ? null : "decompiler open failed: " + ifc.getLastMessage();
    try {
      for (String line : list) {
        if (line.trim().isEmpty()) continue;
        String[] parts = line.split("\t", -1);
        String key = parts[0];
        long va = Long.parseUnsignedLong(parts[1].startsWith("0x") ? parts[1].substring(2) : parts[1], 16);
        String name = parts.length > 2 ? parts[2].trim() : "";
        Address expected = rebased ? currentProgram.getImageBase().add(va - originalBase) : toAddr(va);

        Function function = null;
        String method = null;
        if (!name.isEmpty()) {
          function = unique(name);
          if (function != null) method = "name";
          else {
            function = unique("_" + name);
            if (function != null) method = "underscore-name";
          }
          if (function != null && !function.getEntryPoint().equals(expected)) method = "name-address-mismatch";
        }
        long t0 = System.nanoTime();
        if (function == null) {
          function = getFunctionAt(expected);
          if (function != null) method = rebased ? "rebased-address" : "address";
        }
        // Ghidra's auto-analysis may not discover a function that the binary does have (typically in
        // stripped images). Its entry is known from the corpus, so create it the way an analyst would
        // (disassemble, create function) when the address is executable code.
        if (function == null) {
          MemoryBlock block = currentProgram.getMemory().getBlock(expected);
          if (block != null && block.isExecute()) {
            disassemble(expected);
            function = createFunction(expected, null);
            if (function != null) method = "created-at-address";
          }
        }

        if (function == null) {
          record(results, key, "not_found", null, null, null, null, 0, "no function with that name or at that address, and it could not be created there");
          continue;
        }
        Address entry = function.getEntryPoint();
        String ghidraAddress = "0x" + Long.toHexString(entry.getOffset());
        String address = "0x" + Long.toHexString(rebased ? entry.getOffset() - imageBase + originalBase : entry.getOffset());
        if (openError != null) {
          record(results, key, "failed", method, function.getName(), address, ghidraAddress, 0, openError);
          continue;
        }
        // t0 (taken above the creation step) also covers creation, so a created function's ms includes disassembly.
        try {
          DecompileResults result = ifc.decompileFunction(function, DECOMPILE_TIMEOUT_SECONDS, monitor);
          long ms = (System.nanoTime() - t0) / 1000000;
          if (result.decompileCompleted() && result.getDecompiledFunction() != null) {
            Files.writeString(out.resolve(key + ".c"), result.getDecompiledFunction().getC());
            record(results, key, "complete", method, function.getName(), address, ghidraAddress, ms, null);
          } else {
            String error = result.isTimedOut()
                ? "decompile timed out after " + DECOMPILE_TIMEOUT_SECONDS + " s"
                : String.valueOf(result.getErrorMessage());
            record(results, key, "failed", method, function.getName(), address, ghidraAddress, ms, error);
          }
        } catch (Exception e) {
          long ms = (System.nanoTime() - t0) / 1000000;
          record(results, key, "failed", method, function.getName(), address, ghidraAddress, ms, e.toString());
        }
      }
    } finally {
      ifc.dispose();
    }
  }

  /** The one global function with this exact name, or null when there is none or several. */
  private Function unique(String name) {
    List<Function> functions = getGlobalFunctions(name);
    return functions != null && functions.size() == 1 ? functions.get(0) : null;
  }

  private static void record(
      Path results, String key, String state, String method, String name, String address, String ghidraAddress,
      long ms, String error) throws Exception {
    String json = "{\"fnKey\":" + quote(key)
        + ",\"state\":" + quote(state)
        + ",\"method\":" + quote(method)
        + ",\"name\":" + quote(name)
        + ",\"address\":" + quote(address)
        + ",\"ghidra_address\":" + quote(ghidraAddress)
        + ",\"ms\":" + ms
        + ",\"error\":" + quote(error) + "}\n";
    Files.writeString(results, json, StandardOpenOption.APPEND);
  }

  private static String quote(String value) {
    if (value == null) return "null";
    StringBuilder out = new StringBuilder("\"");
    for (int i = 0; i < value.length(); i++) {
      char c = value.charAt(i);
      switch (c) {
        case '"': out.append("\\\""); break;
        case '\\': out.append("\\\\"); break;
        case '\n': out.append("\\n"); break;
        case '\r': out.append("\\r"); break;
        case '\t': out.append("\\t"); break;
        default:
          if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
          else out.append(c);
      }
    }
    return out.append('"').toString();
  }
}
