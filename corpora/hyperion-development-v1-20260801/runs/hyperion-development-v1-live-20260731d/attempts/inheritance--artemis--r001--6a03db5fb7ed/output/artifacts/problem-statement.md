# Geometric Shapes – Inheritance and Polymorphism

We work with a small hierarchy of geometric shapes. All shapes share a common abstract base class that defines a single polymorphic operation – computing the *extent* (area) of the shape. Your task is to implement the concrete shape classes.

## Public API

```java
package de.tum.cit.aet.exgeninheritanceandpolymorphism;

public abstract class Shape {
    public abstract double getExtent();
}
```

```java
package de.tum.cit.aet.exgeninheritanceandpolymorphism;

public class Rectangle extends Shape {
    public Rectangle(double width, double height) { /* … */ }
    public double getWidth() { /* … */ }
    public double getHeight() { /* … */ }
    @Override
    public double getExtent() { /* … */ }
}
```

```java
package de.tum.cit.aet.exgeninheritanceandpolymorphism;

public class Triangle extends Shape {
    public Triangle(double base, double height) { /* … */ }
    public double getBase() { /* … */ }
    public double getHeight() { /* … */ }
    @Override
    public double getExtent() { /* … */ }
}
```

```java
package de.tum.cit.aet.exgeninheritanceandpolymorphism;

public class Circle extends Shape {
    public Circle(double radius) { /* … */ }
    public double getRadius() { /* … */ }
    @Override
    public double getExtent() { /* … */ }
}
```

All dimensional arguments (`width`, `height`, `base`, `radius`) are non‑negative. The classes are immutable – no setters are required.

## Tasks

[task][Implement Rectangle shape](<testid>55</testid>,<testid>60</testid>,<testid>63</testid>,<testid>64</testid>,<testid>53</testid>,<testid>57</testid>,<testid>68</testid>,<testid>50</testid>)
Implement the `Rectangle` class: store the given width and height, provide the corresponding getters, and compute the area as `width * height`.

[task][Implement Triangle shape](<testid>49</testid>,<testid>61</testid>,<testid>58</testid>,<testid>54</testid>,<testid>65</testid>,<testid>52</testid>,<testid>66</testid>)
Implement the `Triangle` class: store the base and height, provide the getters, and compute the area as `0.5 * base * height`.

[task][Implement Circle shape](<testid>62</testid>,<testid>56</testid>,<testid>69</testid>,<testid>51</testid>,<testid>67</testid>,<testid>59</testid>)
Implement the `Circle` class: store the radius, provide the getter, and compute the area as `Math.PI * radius * radius`.

## Diagram

```plantuml
@startuml
class Shape {
    +double getExtent()
}

class Rectangle {
    <color:testsColor(<testid>68</testid>)>+Rectangle(double width, double height)</color>
    <color:testsColor(<testid>50</testid>)>+double getWidth()</color>
    <color:testsColor(<testid>50</testid>)>+double getHeight()</color>
    <color:testsColor(<testid>50</testid>)>+double getExtent()</color>
}

class Triangle {
    <color:testsColor(<testid>52</testid>)>+Triangle(double base, double height)</color>
    <color:testsColor(<testid>66</testid>)>+double getBase()</color>
    <color:testsColor(<testid>66</testid>)>+double getHeight()</color>
    <color:testsColor(<testid>66</testid>)>+double getExtent()</color>
}

class Circle {
    <color:testsColor(<testid>67</testid>)>+Circle(double radius)</color>
    <color:testsColor(<testid>59</testid>)>+double getRadius()</color>
    <color:testsColor(<testid>59</testid>)>+double getExtent()</color>
}

Rectangle -up-|> Shape #testsColor(<testid>57</testid>)
Triangle -up-|> Shape #testsColor(<testid>65</testid>)
Circle -up-|> Shape #testsColor(<testid>51</testid>)
hide empty fields
hide empty methods
@enduml
```