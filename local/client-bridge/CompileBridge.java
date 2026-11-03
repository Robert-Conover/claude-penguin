import com.jpexs.decompiler.flash.SWF;
import com.jpexs.decompiler.flash.action.parser.script.ActionScript2Parser;
import com.jpexs.decompiler.flash.tags.DoActionTag;
import java.nio.file.Files;
import java.nio.file.Path;

/** Compile only our additional AVM1 actions; never recompile archived scripts. */
public final class CompileBridge {
    public static void main(String[] args) throws Exception {
        try (var input = Files.newInputStream(Path.of(args[0]))) {
            var swf = new SWF(input, false);
            if (swf.isAS3()) throw new IllegalArgumentException("Expected AVM1 engine");
            var tag = new DoActionTag(swf);
            var parser = new ActionScript2Parser(swf, tag);
            tag.setActions(parser.actionsFromString(Files.readString(Path.of(args[1])), "UTF-8"));
            Files.write(Path.of(args[2]), tag.getActionBytes().getRangeData());
        }
    }
}
