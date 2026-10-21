
import ghidra.app.script.GhidraScript;
import ghidra.app.decompiler.*;
import ghidra.program.model.listing.*;
import ghidra.program.model.address.*;
import java.nio.file.*;
import java.util.*;

public class DecompileList extends GhidraScript {
  @Override
  public void run() throws Exception {
    String[] args = getScriptArgs();
    Path list = Paths.get(args[0]);
    Path out = Paths.get(args[1]);
    Files.createDirectories(out);
    DecompInterface ifc = new DecompInterface();
    DecompileOptions opts = new DecompileOptions();
    opts.grabFromProgram(currentProgram);
    ifc.setOptions(opts);
    ifc.toggleCCode(true);
    ifc.toggleSyntaxTree(true);
    ifc.setSimplificationStyle("decompile");
    if (!ifc.openProgram(currentProgram)) { println("open failed: " + ifc.getLastMessage()); return; }
    for (String line : Files.readAllLines(list)) {
      line = line.trim();
      if (line.isEmpty()) continue;
      String[] parts = line.split("\t");
      String name = parts[1];
      Function f = null;
      List<Function> byName = getGlobalFunctions(name);
      if (byName != null && byName.size() == 1) f = byName.get(0);
      if (f == null) { try { f = getFunctionAt(toAddr(parts[0])); } catch (Exception e) {} }
      if (f == null) { for (Function g : currentProgram.getFunctionManager().getFunctions(true)) { if (g.getName().equals("_" + name)) { f = g; break; } } }
      String text;
      if (f == null) text = "/* NOT FOUND */\n";
      else {
        long t0 = System.nanoTime();
        DecompileResults r = ifc.decompileFunction(f, 300, monitor);
        long ms = (System.nanoTime() - t0) / 1000000;
        text = r.decompileCompleted() ? r.getDecompiledFunction().getC() : "/* FAILED: " + r.getErrorMessage() + " */\n";
        text = "/* ghidra " + f.getName() + " @ " + f.getEntryPoint() + " " + ms + " ms */\n" + text;
      }
      Files.writeString(out.resolve(parts[2] + ".c"), text);
    }
    ifc.dispose();
  }
}
