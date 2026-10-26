# Temperature Range

A room sensor reports the current temperature in degrees Celsius. The building manager has defined a
comfortable range for each room, given by a minimum and a maximum temperature. You complete the class
`TemperatureRange`, which checks a reading against the range and describes the range for the
sensor's display.

### Tasks

1. [task][Check a temperature](testContainsValueInside,testContainsOnlyValuesInside,test1)
   Implement `contains`, which returns `true` if a temperature lies between the minimum and the
   maximum of the range, and `false` otherwise.

2. [task][Describe the range](testDescribe,test2)
   Implement `describe`, which returns a short one-line summary of the range that names its minimum
   and its maximum in degrees Celsius.
