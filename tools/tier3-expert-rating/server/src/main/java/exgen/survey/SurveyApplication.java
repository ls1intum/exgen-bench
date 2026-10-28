package exgen.survey;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

/** The survey server, or one of the study team's commands when the first argument names one. */
@SpringBootApplication
@ConfigurationPropertiesScan
public class SurveyApplication {
    public static void main(String[] args) {
        if (args.length > 0 && Commands.NAMES.contains(args[0])) {
            System.exit(Commands.run(args));
        }
        SpringApplication.run(SurveyApplication.class, args);
    }
}
