#!/bin/bash
# Disconnect ens18 and delete dhcp leases
echo "Start changing IP address..."
ifdown ens18 && rm -f /var/lib/dhcp/dhclient*

# Sleep seconds
SLEEP_DURATION=900

echo "IP address is changing, Please wait ${SLEEP_DURATION} seconds:"

while [ $SLEEP_DURATION -gt 0 ]; do
    printf "\r %4d seconds remaining..." "$SLEEP_DURATION"
    sleep 1
    SLEEP_DURATION=$((SLEEP_DURATION - 1))
done

echo

echo "Obtaining IP address..."
ifup ens18

cIP=$(ip addr show ens18 | grep -w inet | awk '{print $2}' | cut -d/ -f1)

echo "The IP address has been changed successfully: ${cIP}"

echo "Thank you for choosing DogeVM!"