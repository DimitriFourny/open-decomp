export const ENCODINGS = [
    {
        "instructionId": "LDAPRB",
        "encodingId": "LDAPRB_32L_memop",
        "mnemonic": "LDAPRB",
        "className": "Integer",
        "fileName": "ldaprb.xml",
        "mask": 4292934656,
        "value": 950059008,
        "bitCount": 17,
        "fields": [
            {
                "name": "size",
                "lsb": 30,
                "width": 2
            },
            {
                "name": "VR",
                "lsb": 26,
                "width": 1
            },
            {
                "name": "A",
                "lsb": 23,
                "width": 1
            },
            {
                "name": "R",
                "lsb": 22,
                "width": 1
            },
            {
                "name": "Rs",
                "lsb": 16,
                "width": 5
            },
            {
                "name": "o3",
                "lsb": 15,
                "width": 1
            },
            {
                "name": "opc",
                "lsb": 12,
                "width": 3
            },
            {
                "name": "Rn",
                "lsb": 5,
                "width": 5
            },
            {
                "name": "Rt",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_LRCPC"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_LRCPC",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "ldapr-byte-halfword"
    }
];
