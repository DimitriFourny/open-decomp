// odbench: pre-script. Runs after Ghidra has imported the file and before auto-analysis starts;
// the milliseconds-since-epoch it writes mark the end of "JVM start + import" and the start of
// "analysis" (OdbenchDecompile.java reads it back). The class name must equal the file name.
import ghidra.app.script.GhidraScript;
import java.nio.file.Files;
import java.nio.file.Paths;

public class OdbenchMark extends GhidraScript {
  @Override
  public void run() throws Exception {
    String[] args = getScriptArgs();
    Files.writeString(Paths.get(args[0]), Long.toString(System.currentTimeMillis()));
  }
}
