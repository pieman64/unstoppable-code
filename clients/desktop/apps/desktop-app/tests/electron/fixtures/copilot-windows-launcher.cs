// Windows stand-in for the Copilot CLI fixture. The managed runtime spawns the
// installed `copilot.exe` directly, so on Windows the fixture must be a real
// executable rather than a shebang script. copilot-runtime.mjs fills in the
// Node and agent paths, then compiles this with the .NET Framework C# compiler
// that ships with Windows. The launcher starts Node on the fake SDK agent with
// the host's arguments, inherited stdio and environment, and exits with
// Node's exit code, so process ownership behaves like the real CLI.
using System.Diagnostics;
using System.Text;

static class Launcher
{
    static int Main(string[] args)
    {
        var arguments = new StringBuilder();
        arguments.Append('"').Append(@"__SCRIPT__").Append('"');
        foreach (var argument in args)
            arguments.Append(' ').Append(Quote(argument));
        var start = new ProcessStartInfo
        {
            FileName = @"__NODE__",
            Arguments = arguments.ToString(),
            UseShellExecute = false,
        };
        using (var process = Process.Start(start))
        {
            process.WaitForExit();
            return process.ExitCode;
        }
    }

    // Quote one argument the way CommandLineToArgvW parses it: double the
    // backslashes that precede a quote or the end of the argument, and escape
    // embedded quotes.
    static string Quote(string argument)
    {
        var quoted = new StringBuilder("\"");
        var backslashes = 0;
        foreach (var character in argument)
        {
            if (character == '\\')
            {
                backslashes++;
                continue;
            }
            if (character == '"')
            {
                quoted.Append('\\', backslashes * 2 + 1).Append('"');
                backslashes = 0;
                continue;
            }
            quoted.Append('\\', backslashes).Append(character);
            backslashes = 0;
        }
        return quoted.Append('\\', backslashes * 2).Append('"').ToString();
    }
}
