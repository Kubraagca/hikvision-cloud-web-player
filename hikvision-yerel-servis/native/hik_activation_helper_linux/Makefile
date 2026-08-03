SDK_ROOT ?= ../../third_party/hcnetsdk_linux64/EN-HCNetSDKV6.1.9.48_build20230410_linux64
SDK_INC := $(SDK_ROOT)/incEn
SDK_LIB := $(SDK_ROOT)/lib
BUILD_DIR := build
TARGET := $(BUILD_DIR)/hik_activation_helper

CXX := g++
CXXFLAGS := -std=c++20 -O2 -Wall -Wextra -I$(SDK_INC)
LDFLAGS := -L$(SDK_LIB) -lhcnetsdk -Wl,-rpath,'$$ORIGIN/../../../third_party/hcnetsdk_linux64/EN-HCNetSDKV6.1.9.48_build20230410_linux64/lib'

all: $(TARGET)

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

$(TARGET): activate_camera.cpp | $(BUILD_DIR)
	$(CXX) $(CXXFLAGS) activate_camera.cpp -o $(TARGET) $(LDFLAGS)

clean:
	rm -rf $(BUILD_DIR)

.PHONY: all clean
