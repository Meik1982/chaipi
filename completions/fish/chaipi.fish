# Fish completion for chaipi and local-browser-ai

for cmd in chaipi local-browser-ai
    # Dateivervollständigung standardmäßig deaktivieren
    complete -c $cmd -f

    # Subbefehle
    complete -c $cmd -n "__fish_use_subcommand" -a daemon -d "Steuert den Hintergrund-Worker mit warmer Chrome-Instanz"
    complete -c $cmd -n "__fish_use_subcommand" -a stats -d "Zeigt Quota-Einsparungen und Token-Raten"
    complete -c $cmd -n "__fish_use_subcommand" -a serve -d "Startet OpenAI-kompatiblen HTTP-Server"
    complete -c $cmd -n "__fish_use_subcommand" -a completion -d "Generiert Autovervollständigung für Shell"

    # Daemon Subbefehle
    complete -c $cmd -n "__fish_seen_subcommand_from daemon" -a "start" -d "Startet den Hintergrund-Daemon"
    complete -c $cmd -n "__fish_seen_subcommand_from daemon" -a "stop" -d "Beendet den Hintergrund-Daemon"
    complete -c $cmd -n "__fish_seen_subcommand_from daemon" -a "status" -d "Zeigt Status des Hintergrund-Daemons"
    complete -c $cmd -n "__fish_seen_subcommand_from daemon" -a "restart" -d "Startet den Hintergrund-Daemon neu"
    complete -c $cmd -n "__fish_seen_subcommand_from daemon" -a "run" -d "Führt den Daemon im Vordergrund aus"

    # Completion Shells
    complete -c $cmd -n "__fish_seen_subcommand_from completion" -a "bash zsh fish"

    # Serve Optionen
    complete -c $cmd -n "__fish_seen_subcommand_from serve" -l port -s p -d "Port für HTTP-Server" -r
    complete -c $cmd -n "__fish_seen_subcommand_from serve" -l host -d "Host für HTTP-Server" -r

    # Allgemeine Optionen
    complete -c $cmd -l check -d "Fragt Modellverfügbarkeit und Browser-Fähigkeiten ab"
    complete -c $cmd -l stream -d "Gibt Tokens in Echtzeit direkt auf stdout aus"
    complete -c $cmd -l stats -d "Gibt Token- und Performance-Metriken auf stderr aus"
    complete -c $cmd -l chunk -d "Automatisches Chunking & Map-Reduce für lange Dokumente"
    complete -c $cmd -l map-reduce -d "Automatisches Chunking & Map-Reduce für lange Dokumente"
    complete -c $cmd -l no-chunk -d "Deaktiviert Chunking (erzwingt Einzelanfrage)"
    complete -c $cmd -s s -l system -d "Definiert einen System-Prompt" -r
    complete -c $cmd -s t -l temperature -d "Steuert Modell-Kreativität (0.0 - 1.0)" -r
    complete -c $cmd -l top-k -d "Begrenzt den Sampling-Pool" -r
    complete -c $cmd -l no-daemon -d "Erzwingt Standalone-Ausführung ohne Daemon"
    complete -c $cmd -l profile -d "Verwendet bestimmtes Profilverzeichnis" -r -a "(__fish_complete_directories)"
    complete -c $cmd -l temp-profile -d "Erzwingt isoliertes temporäres Profil"
    complete -c $cmd -l url -d "Kontext-URL im Headless-Tab" -r
    complete -c $cmd -l json -d "Gibt Ausgabe als strukturiertes JSON zurück"
    complete -c $cmd -s V -l verbose -d "Ausführliche Diagnose- und Statusausgabe auf stderr"
    complete -c $cmd -s v -l version -d "Zeigt Versionsnummer an"
    complete -c $cmd -s h -l help -d "Zeigt Hilfetext an"
end
