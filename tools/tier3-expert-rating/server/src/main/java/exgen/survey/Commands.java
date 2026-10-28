package exgen.survey;

import exgen.survey.export.ExportArchive;
import exgen.survey.rating.SurveyStore;
import exgen.survey.study.LoadedStudy;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.WebApplicationType;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * The study team's commands, run in the survey's container against its database:
 *
 * <pre>
 * survey link --admin | --rater R1 [--rater R2 ...]   issue personal links; a new link revokes the earlier one
 * survey withdraw --rater R3                          delete a rater's answers at their request
 * survey export --output export.zip [--role main ...] export the answers with a codebook
 * </pre>
 */
final class Commands {
    static final Set<String> NAMES = Set.of("link", "withdraw", "export");

    private Commands() {}

    static int run(String[] args) {
        var command = args[0];
        var options = new Options(List.of(args).subList(1, args.length));
        var application = new SpringApplication(SurveyApplication.class);
        application.setWebApplicationType(WebApplicationType.NONE);
        application.setDefaultProperties(Map.of("logging.level.root", "warn"));
        try (ConfigurableApplicationContext context = application.run()) {
            var store = context.getBean(SurveyStore.class);
            var loaded = context.getBean(LoadedStudy.class);
            var properties = context.getBean(SurveyProperties.class);
            switch (command) {
                case "link" -> {
                    var holders = new ArrayList<String>(options.all("--rater"));
                    if (options.flag("--admin")) {
                        holders.add(null);
                    }
                    if (holders.isEmpty()) {
                        return fail("name --rater or --admin");
                    }
                    for (var holder : holders) {
                        if (holder == null) {
                            continue;
                        }
                        var rater = store.rater(holder);
                        if (rater.isEmpty()) {
                            return fail("unknown rater " + holder);
                        }
                        if (rater.get().withdrawnAt() != null) {
                            return fail(holder + " withdrew, so they get no new link");
                        }
                    }
                    for (var holder : holders) {
                        var link = properties.publicUrl().resolve("/r/" + store.issueLink(holder));
                        System.out.println((holder == null ? "study team" : holder) + "\t" + link);
                    }
                }
                case "withdraw" -> {
                    var rater = options.one("--rater");
                    if (rater == null || store.rater(rater).isEmpty()) {
                        return fail("name a rater of the study with --rater");
                    }
                    store.withdraw(rater);
                    System.out.println(rater + " withdrew; their answers are deleted");
                }
                case "export" -> {
                    var output = options.one("--output");
                    if (output == null) {
                        return fail("name the ZIP file to write with --output");
                    }
                    var roles = options.all("--role").isEmpty() ? List.of("main", "reserve") : options.all("--role");
                    var path = Path.of(output).toAbsolutePath();
                    Files.write(path, ExportArchive.archive(loaded, store, roles));
                    System.out.println(path);
                }
                default -> throw new IllegalArgumentException(command);
            }
            return 0;
        } catch (IOException error) {
            return fail(error.getMessage());
        }
    }

    private static int fail(String message) {
        System.err.println(message);
        return 1;
    }

    /** {@code --name value} pairs and {@code --flag}s, in the order given. */
    private record Options(List<String> args) {
        List<String> all(String name) {
            var values = new ArrayList<String>();
            for (int index = 0; index < args.size() - 1; index++) {
                if (args.get(index).equals(name)) {
                    values.add(args.get(index + 1));
                }
            }
            return values;
        }

        String one(String name) {
            var values = all(name);
            return values.isEmpty() ? null : values.getLast();
        }

        boolean flag(String name) {
            return args.contains(name);
        }
    }
}
