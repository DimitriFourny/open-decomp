export const ENCODINGS = [
    {
        "instructionId": "cntp_r_pn",
        "encodingId": "cntp_r_pn_",
        "mnemonic": "CNTP",
        "className": "SVE2",
        "fileName": "cntp_r_pn.xml",
        "mask": 4282382848,
        "value": 622887424,
        "bitCount": 20,
        "fields": [
            {
                "name": "size",
                "lsb": 22,
                "width": 2
            },
            {
                "name": "opc",
                "lsb": 16,
                "width": 3
            },
            {
                "name": "vl",
                "lsb": 10,
                "width": 1
            },
            {
                "name": "PNn",
                "lsb": 5,
                "width": 4
            },
            {
                "name": "Rd",
                "lsb": 0,
                "width": 5
            }
        ],
        "features": [
            "FEAT_SME2 || FEAT_SVE2p1"
        ],
        "featureGuards": [],
        "guards": [
            {
                "all": [
                    {
                        "kind": "feature",
                        "feature": "FEAT_SME2",
                        "implemented": false
                    },
                    {
                        "kind": "feature",
                        "feature": "FEAT_SVE2p1",
                        "implemented": false
                    }
                ],
                "outcome": "undefined"
            }
        ],
        "operandFamilyId": "sve-count-predicate"
    }
];
