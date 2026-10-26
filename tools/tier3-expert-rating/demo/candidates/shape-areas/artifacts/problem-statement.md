# Shape Areas

A drawing app lets users place circles, rectangles and squares on a canvas. To estimate how much paint
a drawing needs, the app adds up the area of every shape on the canvas. Each kind of shape computes
its area and perimeter differently, but the canvas should not have to care which kind of shape it is
looking at.

All shapes implement the interface `Shape`. A `Square` is a special `Rectangle` whose sides are all
equally long, so it extends `Rectangle` and does not compute anything itself.

```plantuml
@startuml
interface Shape {
  +area(): double
  +perimeter(): double
}
class Circle #testsColor(testCircleArea) {
  -radius: double
  +Circle(radius: double)
}
class Rectangle #testsColor(testRectanglePerimeter) {
  -width: double
  -height: double
  +Rectangle(width: double, height: double)
}
class Square #testsColor(testSquareArea) {
  +Square(side: double)
}
class ShapeCollection #testsColor(testTotalAreaOfMixedShapes) {
  +add(shape: Shape)
  +totalArea(): double
}
Shape <|.. Circle
Shape <|.. Rectangle
Rectangle <|-- Square
ShapeCollection o-- "*" Shape
@enduml
```

### Tasks

1. [task][Circle](<testid>101</testid>,<testid>102</testid>)
   Implement `area()` and `perimeter()` in `Circle`. Use `Math.PI`.

2. [task][Rectangle and Square](<testid>103</testid>,<testid>104</testid>,<testid>105</testid>)
   Implement `perimeter()` in `Rectangle`. Complete the constructor of `Square` so that a square with
   side length `s` is a rectangle of width `s` and height `s`.

3. [task][Shape collection](<testid>106</testid>,<testid>107</testid>,<testid>108</testid>)
   Implement `totalArea()` in `ShapeCollection`. It returns the sum of the areas of all shapes in the
   collection, and `0.0` for an empty collection. It must work for every kind of `Shape`, including
   kinds that are added to the app later.
